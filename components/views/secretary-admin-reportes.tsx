"use client"

import { useState, useEffect, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import {
  CalendarDays, Loader2, ZoomIn, CheckCircle2, XCircle, Clock,
  ChevronDown, ChevronUp, Bell, BellRing,
} from "lucide-react"
import type { AuthenticatedUser } from "@/components/views/login-view"

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface AdminInformeImagen {
  id: string
  url_imagen: string
  nombre_archivo: string | null
}

interface AdminInformeRevision {
  id: string
  accion: "aprobado" | "rechazado"
  secretaria_nombre: string
  comentario: string | null
  version_reporte: number
  created_at: string
}

interface AdminInforme {
  id: string
  admin_id: number
  admin_nombre: string
  fecha: string
  nombre_reporte: string
  notas: string | null
  estado: "pendiente" | "aprobado" | "rechazado"
  revision_secretaria_id: number | null
  revision_secretaria_nombre: string | null
  revision_comentario: string | null
  version: number
  created_at: string
  updated_at: string
  admin_informe_imagenes: AdminInformeImagen[]
  admin_informe_revisiones: AdminInformeRevision[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fechaColombiaHoy(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date())
}

function fechaColombiaAyer(): string {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }))
  d.setDate(d.getDate() - 1)
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(d)
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

function EstadoBadge({ estado }: { estado: "pendiente" | "aprobado" | "rechazado" }) {
  if (estado === "aprobado") return (
    <Badge className="gap-1 bg-green-500/15 text-green-700 border-green-500/30 hover:bg-green-500/20 shrink-0">
      <CheckCircle2 className="h-3 w-3" /> Aprobado
    </Badge>
  )
  if (estado === "rechazado") return (
    <Badge className="gap-1 bg-destructive/15 text-destructive border-destructive/30 hover:bg-destructive/20 shrink-0">
      <XCircle className="h-3 w-3" /> Rechazado
    </Badge>
  )
  return (
    <Badge variant="outline" className="gap-1 border-amber-400/50 text-amber-600 shrink-0">
      <Clock className="h-3 w-3" /> En revisión
    </Badge>
  )
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function SecretaryAdminReportes({ currentUser }: { currentUser: AuthenticatedUser }) {
  const hoy = fechaColombiaHoy()
  const ayer = fechaColombiaAyer()
  const [selectedDate, setSelectedDate] = useState(hoy)
  const selectedDateRef = useRef(hoy)
  useEffect(() => { selectedDateRef.current = selectedDate }, [selectedDate])
  const initialCheckRef = useRef(false)

  const [informes, setInformes] = useState<AdminInforme[]>([])
  const [loading, setLoading] = useState(true)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())

  // Push
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">("default")

  // Dialog aprobar (con comentario opcional)
  const [approveTarget, setApproveTarget] = useState<AdminInforme | null>(null)
  const [approveComment, setApproveComment] = useState("")
  const [approving, setApproving] = useState(false)

  // Dialog rechazar
  const [rejectTarget, setRejectTarget] = useState<AdminInforme | null>(null)
  const [rejectComment, setRejectComment] = useState("")
  const [rejecting, setRejecting] = useState(false)

  const uid = String(currentUser.id)

  // Notificaciones
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!("Notification" in window) || !("serviceWorker" in navigator)) { setNotifPermission("unsupported"); return }
    setNotifPermission(Notification.permission)
    if (Notification.permission === "granted") subscribeToPush(uid).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function subscribeToPush(userId: string) {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    if (!vapidKey) return
    const reg = await navigator.serviceWorker.ready
    let existing = await reg.pushManager.getSubscription()
    if (existing && !existing.options?.applicationServerKey) { await existing.unsubscribe(); existing = null }
    const sub = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    })
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, rol: "secretaria", subscription: sub.toJSON() }),
    })
  }

  const requestPermission = async () => {
    if (!("Notification" in window)) return
    const result = await Notification.requestPermission()
    setNotifPermission(result)
    if (result === "granted") await subscribeToPush(uid).catch(() => {})
  }

  // Fetch por fecha
  const fetchInformes = async (fecha: string): Promise<AdminInforme[]> => {
    const supabase = createClient()
    const { data, error } = await supabase
      .from("admin_informes")
      .select("*, admin_informe_imagenes(*), admin_informe_revisiones(id, accion, secretaria_nombre, comentario, version_reporte, created_at)")
      .eq("fecha", fecha)
      .order("admin_nombre", { ascending: true })
      .order("created_at", { ascending: true })
    if (error) console.error("[v0] SecretaryAdminReportes fetch error:", error)
    const result = (data as AdminInforme[]) ?? []
    setInformes(result)
    setOpenGroups(new Set(result.map((i) => i.admin_nombre)))
    return result
  }

  // En el primer load, si hoy no tiene reportes → mostrar ayer automáticamente
  useEffect(() => {
    setLoading(true)
    fetchInformes(selectedDate).then((rows) => {
      if (!initialCheckRef.current && selectedDate === hoy && rows.length === 0) {
        initialCheckRef.current = true
        setSelectedDate(ayer)
      } else {
        initialCheckRef.current = true
        setLoading(false)
      }
    }).catch(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate])

  // Realtime INSERT y UPDATE
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel("secretary-admin-informes-rt")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "admin_informes" }, (payload) => {
        const raw = payload.new as AdminInforme
        // Si el nuevo reporte es de hoy y se está viendo ayer → saltar a hoy
        if (raw.fecha === hoy && selectedDateRef.current === ayer) {
          setSelectedDate(hoy)
          return
        }
        if (raw.fecha !== selectedDateRef.current) return
        setInformes((prev) => {
          if (prev.find((i) => i.id === raw.id)) return prev
          return [...prev, { ...raw, admin_informe_imagenes: [], admin_informe_revisiones: [] }]
        })
        setOpenGroups((prev) => new Set([...prev, raw.admin_nombre]))
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "admin_informes" }, (payload) => {
        const raw = payload.new as AdminInforme
        setInformes((prev) => prev.map((i) =>
          i.id === raw.id ? { ...i, ...raw, admin_informe_revisiones: i.admin_informe_revisiones } : i
        ))
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // Agrupar por admin_nombre
  const grupos = informes.reduce<Record<string, AdminInforme[]>>((acc, inf) => {
    if (!acc[inf.admin_nombre]) acc[inf.admin_nombre] = []
    acc[inf.admin_nombre].push(inf)
    return acc
  }, {})

  const toggleGroup = (nombre: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(nombre)) next.delete(nombre); else next.add(nombre)
      return next
    })
  }

  // Aprobar
  const openApprove = (informe: AdminInforme) => { setApproveTarget(informe); setApproveComment("") }
  const closeApprove = () => { setApproveTarget(null); setApproveComment("") }

  const handleConfirmarAprobacion = async () => {
    if (!approveTarget) return
    setApproving(true)
    try {
      const supabase = createClient()
      const ahora = new Date().toISOString()
      const comentarioFinal = approveComment.trim() || null
      await supabase
        .from("admin_informes")
        .update({
          estado: "aprobado",
          revision_secretaria_id: Number(currentUser.id),
          revision_secretaria_nombre: currentUser.nombre,
          revision_comentario: comentarioFinal,
          revision_at: ahora,
          updated_at: ahora,
        })
        .eq("id", approveTarget.id)
        .eq("estado", "pendiente")
      await supabase.from("admin_informe_revisiones").insert({
        admin_informe_id: approveTarget.id,
        accion: "aprobado",
        secretaria_id: Number(currentUser.id),
        secretaria_nombre: currentUser.nombre,
        comentario: comentarioFinal,
        version_reporte: approveTarget.version,
      })
      const nuevaRevision: AdminInformeRevision = {
        id: crypto.randomUUID(),
        accion: "aprobado",
        secretaria_nombre: currentUser.nombre,
        comentario: comentarioFinal,
        version_reporte: approveTarget.version,
        created_at: ahora,
      }
      setInformes((prev) => prev.map((i) =>
        i.id === approveTarget.id
          ? { ...i, estado: "aprobado", revision_secretaria_nombre: currentUser.nombre, revision_comentario: comentarioFinal, admin_informe_revisiones: [...i.admin_informe_revisiones, nuevaRevision] }
          : i
      ))
      fetch("/api/push/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Reporte aprobado ✓",
          body: comentarioFinal ?? approveTarget.nombre_reporte,
          tag: `admin-informe-${approveTarget.id}`,
          url: "/",
          user_id: approveTarget.admin_id,
        }),
      }).catch(() => {})
      closeApprove()
    } catch (e) {
      console.error("[v0] SecretaryAdminReportes aprobar error:", e)
    } finally {
      setApproving(false)
    }
  }

  // Rechazar
  const openReject = (informe: AdminInforme) => { setRejectTarget(informe); setRejectComment("") }
  const closeReject = () => { setRejectTarget(null); setRejectComment("") }

  const handleRechazar = async () => {
    if (!rejectTarget || !rejectComment.trim()) return
    setRejecting(true)
    try {
      const supabase = createClient()
      const ahora = new Date().toISOString()
      const comentario = rejectComment.trim()
      await supabase
        .from("admin_informes")
        .update({
          estado: "rechazado",
          revision_secretaria_id: Number(currentUser.id),
          revision_secretaria_nombre: currentUser.nombre,
          revision_comentario: comentario,
          revision_at: ahora,
          updated_at: ahora,
        })
        .eq("id", rejectTarget.id)
        .eq("estado", "pendiente")
      await supabase.from("admin_informe_revisiones").insert({
        admin_informe_id: rejectTarget.id,
        accion: "rechazado",
        secretaria_id: Number(currentUser.id),
        secretaria_nombre: currentUser.nombre,
        comentario,
        version_reporte: rejectTarget.version,
      })
      const nuevaRevision: AdminInformeRevision = {
        id: crypto.randomUUID(),
        accion: "rechazado",
        secretaria_nombre: currentUser.nombre,
        comentario,
        version_reporte: rejectTarget.version,
        created_at: ahora,
      }
      setInformes((prev) => prev.map((i) =>
        i.id === rejectTarget.id
          ? { ...i, estado: "rechazado", revision_secretaria_nombre: currentUser.nombre, revision_comentario: comentario, admin_informe_revisiones: [...i.admin_informe_revisiones, nuevaRevision] }
          : i
      ))
      fetch("/api/push/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Reporte rechazado",
          body: comentario,
          tag: `admin-informe-${rejectTarget.id}`,
          url: "/",
          user_id: rejectTarget.admin_id,
        }),
      }).catch(() => {})
      closeReject()
    } catch (e) {
      console.error("[v0] SecretaryAdminReportes rechazar error:", e)
    } finally {
      setRejecting(false)
    }
  }

  const esHoy = selectedDate === hoy
  const [sy, sm, sd] = selectedDate.split("-").map(Number)
  const fechaDisplay = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", weekday: "long", day: "numeric", month: "long",
  }).format(new Date(sy, sm - 1, sd))

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-2xl mx-auto">
      {/* Encabezado */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 flex-1">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-border overflow-hidden p-0.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
          </div>
          <div>
            <h2 className="text-base md:text-xl font-bold">Reportes Admin</h2>
            <p className="text-xs text-muted-foreground">Reportes de administradores</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <div className="flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              type="date"
              value={selectedDate}
              max={hoy}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="h-8 md:h-9 text-xs md:text-sm w-36"
            />
          </div>
          {notifPermission !== "unsupported" && (
            notifPermission === "granted" ? (
              <button
                type="button"
                title="Notificaciones activas"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card hover:bg-muted transition-colors"
              >
                <BellRing className="h-4 w-4 text-brand" />
              </button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={requestPermission}
                disabled={notifPermission === "denied"}
                className="h-8 gap-1.5 text-xs px-2.5"
              >
                <Bell className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">
                  {notifPermission === "denied" ? "Bloqueadas" : "Activar avisos"}
                </span>
              </Button>
            )
          )}
        </div>
      </div>

      {/* Subtítulo */}
      <p className="text-sm font-medium capitalize text-muted-foreground">
        {esHoy ? "Hoy · " : ""}{fechaDisplay}
      </p>

      {/* Contenido */}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : Object.keys(grupos).length === 0 ? (
        <div className="text-center text-muted-foreground text-sm py-10">
          No hay reportes de administradores para este día.
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(grupos).map(([adminNombre, items]) => {
            const isOpen = openGroups.has(adminNombre)
            const pendientes = items.filter((i) => i.estado === "pendiente").length
            return (
              <Card key={adminNombre} className="overflow-hidden">
                {/* Header grupo */}
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-4 py-3 hover:bg-muted/50 transition-colors"
                  onClick={() => toggleGroup(adminNombre)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-sm truncate">{adminNombre}</span>
                    {pendientes > 0 && (
                      <Badge variant="outline" className="border-amber-400/50 text-amber-600 text-[10px] px-1.5 py-0 shrink-0">
                        {pendientes} pendiente{pendientes !== 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">{items.length} reporte{items.length !== 1 ? "s" : ""}</span>
                    {isOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </div>
                </button>

                {/* Reportes */}
                {isOpen && (
                  <div className="border-t divide-y">
                    {items.map((inf) => (
                      <CardContent key={inf.id} className="p-4 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-0.5 min-w-0">
                            <p className="font-medium text-sm truncate">{inf.nombre_reporte}</p>
                            {inf.version > 1 && (
                              <span className="text-[10px] text-muted-foreground">versión {inf.version}</span>
                            )}
                          </div>
                          <EstadoBadge estado={inf.estado} />
                        </div>

                        {inf.notas && (
                          <p className="text-xs md:text-sm text-muted-foreground bg-muted/50 rounded-md px-2.5 py-1.5 whitespace-pre-wrap">
                            {inf.notas}
                          </p>
                        )}

                        {inf.admin_informe_imagenes.length > 0 && (
                          <div className="grid grid-cols-3 gap-2">
                            {inf.admin_informe_imagenes.map((img) => (
                              <button
                                key={img.id}
                                type="button"
                                onClick={() => setLightbox(img.url_imagen)}
                                className="relative aspect-square rounded-md overflow-hidden border hover:opacity-90 transition-opacity group"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={img.url_imagen} alt={img.nombre_archivo ?? ""} className="w-full h-full object-cover" />
                                <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors">
                                  <ZoomIn className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                </div>
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Acciones para reportes pendientes */}
                        {inf.estado === "pendiente" && (
                          <div className="flex gap-2 pt-1">
                            <Button
                              size="sm"
                              className="flex-1 gap-1 text-xs bg-green-600 hover:bg-green-700 text-white"
                              onClick={() => openApprove(inf)}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Aprobar
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 gap-1 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => openReject(inf)}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              Rechazar
                            </Button>
                          </div>
                        )}

                        {/* Estado final */}
                        {inf.estado === "aprobado" && inf.revision_secretaria_nombre && (
                          <div className="rounded-md border border-green-500/30 bg-green-500/5 px-2.5 py-2 space-y-1">
                            <p className="text-xs font-medium text-green-700 flex items-center gap-1">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Aprobado por {inf.revision_secretaria_nombre}
                            </p>
                            {inf.revision_comentario && (
                              <p className="text-xs text-muted-foreground whitespace-pre-wrap">{inf.revision_comentario}</p>
                            )}
                          </div>
                        )}

                        {inf.estado === "rechazado" && (
                          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 space-y-1">
                            <p className="text-xs font-medium text-destructive">
                              Rechazado por {inf.revision_secretaria_nombre ?? "secretaria"}
                            </p>
                            {inf.revision_comentario && (
                              <p className="text-xs text-muted-foreground whitespace-pre-wrap">{inf.revision_comentario}</p>
                            )}
                          </div>
                        )}

                        <p className="text-[10px] text-muted-foreground">
                          {new Date(inf.created_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                          {inf.admin_informe_imagenes.length > 0 && ` · ${inf.admin_informe_imagenes.length} imagen${inf.admin_informe_imagenes.length !== 1 ? "es" : ""}`}
                        </p>
                      </CardContent>
                    ))}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {/* Dialog aprobar */}
      <Dialog open={!!approveTarget} onOpenChange={(open) => { if (!open) closeApprove() }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <h2 className="text-sm md:text-base font-bold mb-3">Aprobar reporte</h2>
          <div className="space-y-3">
            {approveTarget && (
              <p className="text-xs text-muted-foreground border rounded-md px-2.5 py-2 bg-muted/50">
                {approveTarget.nombre_reporte}
              </p>
            )}
            <div className="space-y-1">
              <Label className="text-xs md:text-sm">
                Comentario de aprobación <span className="text-muted-foreground">(opcional)</span>
              </Label>
              <Textarea
                value={approveComment}
                onChange={(e) => setApproveComment(e.target.value)}
                placeholder="Observaciones, confirmación, etc..."
                rows={3}
                className="text-xs md:text-sm resize-none"
                autoFocus
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                className="flex-1 h-8 md:h-10 text-xs"
                onClick={closeApprove}
                disabled={approving}
              >
                Cancelar
              </Button>
              <Button
                className="flex-1 h-8 md:h-10 text-xs bg-green-600 hover:bg-green-700 text-white"
                onClick={handleConfirmarAprobacion}
                disabled={approving}
              >
                {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmar aprobación"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog rechazar */}
      <Dialog open={!!rejectTarget} onOpenChange={(open) => { if (!open) closeReject() }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <h2 className="text-sm md:text-base font-bold mb-3">Rechazar reporte</h2>
          <div className="space-y-3">
            {rejectTarget && (
              <p className="text-xs text-muted-foreground border rounded-md px-2.5 py-2 bg-muted/50">
                {rejectTarget.nombre_reporte}
              </p>
            )}
            <div className="space-y-1">
              <Label className="text-xs md:text-sm">
                Motivo del rechazo <span className="text-red-500">*</span>
              </Label>
              <Textarea
                value={rejectComment}
                onChange={(e) => setRejectComment(e.target.value)}
                placeholder="Explica el motivo del rechazo..."
                rows={4}
                className="text-xs md:text-sm resize-none"
                autoFocus
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                className="flex-1 h-8 md:h-10 text-xs"
                onClick={closeReject}
                disabled={rejecting}
              >
                Cancelar
              </Button>
              <Button
                className="flex-1 h-8 md:h-10 text-xs bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                onClick={handleRechazar}
                disabled={rejecting || !rejectComment.trim()}
              >
                {rejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmar rechazo"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
