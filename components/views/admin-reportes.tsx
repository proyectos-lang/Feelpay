"use client"

import { useState, useEffect, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import {
  Plus, Loader2, ImagePlus, X, CalendarDays, ZoomIn,
  CheckCircle2, XCircle, Clock, AlertTriangle, Bell, BellRing,
} from "lucide-react"
import type { AuthenticatedUser } from "@/components/views/login-view"

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface AdminInformeImagen {
  id: string
  url_imagen: string
  nombre_archivo: string | null
}

interface AdminInforme {
  id: string
  admin_id: number
  admin_nombre: string
  fecha: string
  nombre_reporte: string
  notas: string | null
  estado: "pendiente" | "aprobado" | "rechazado"
  revision_secretaria_nombre: string | null
  revision_comentario: string | null
  version: number
  created_at: string
  updated_at: string
  admin_informe_imagenes: AdminInformeImagen[]
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

export function AdminReportes({ currentUser }: { currentUser: AuthenticatedUser }) {
  const hoy = fechaColombiaHoy()
  const [selectedDate, setSelectedDate] = useState(hoy)
  const [informes, setInformes] = useState<AdminInforme[]>([])
  const [loading, setLoading] = useState(true)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const uid = String(currentUser.id)

  // Notificaciones
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">("default")

  // Formulario crear
  const [showForm, setShowForm] = useState(false)
  const [formNombre, setFormNombre] = useState("")
  const [formNotas, setFormNotas] = useState("")
  const [formFecha, setFormFecha] = useState(hoy)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Formulario reenvío
  const [resubmitTarget, setResubmitTarget] = useState<AdminInforme | null>(null)
  const [resubmitNombre, setResubmitNombre] = useState("")
  const [resubmitNotas, setResubmitNotas] = useState("")
  const [resubmitFiles, setResubmitFiles] = useState<File[]>([])
  const [resubmitPreviews, setResubmitPreviews] = useState<string[]>([])
  const [resubmitting, setResubmitting] = useState(false)
  const resubmitFileRef = useRef<HTMLInputElement>(null)

  // Notificaciones push
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!("Notification" in window) || !("serviceWorker" in navigator)) { setNotifPermission("unsupported"); return }
    setNotifPermission(Notification.permission)
    if (Notification.permission === "granted") subscribeToPush(uid).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch reportes por fecha
  useEffect(() => {
    setLoading(true)
    const supabase = createClient()
    supabase
      .from("admin_informes")
      .select("*, admin_informe_imagenes(*)")
      .eq("admin_id", Number(uid))
      .eq("fecha", selectedDate)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) console.error("[v0] AdminReportes fetch error:", error)
        setInformes((data as AdminInforme[]) ?? [])
        setLoading(false)
      })
  }, [selectedDate, uid])

  // Realtime: escuchar UPDATEs (secretaria aprobó/rechazó)
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel("admin-informes-rt")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "admin_informes" }, (payload) => {
        const raw = payload.new as AdminInforme
        if (Number(raw.admin_id) !== Number(uid)) return
        setInformes((prev) => prev.map((i) => i.id === raw.id ? { ...i, ...raw } : i))
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
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
      body: JSON.stringify({ user_id: userId, rol: "admin", subscription: sub.toJSON() }),
    })
  }

  const requestPermission = async () => {
    if (!("Notification" in window)) return
    const result = await Notification.requestPermission()
    setNotifPermission(result)
    if (result === "granted") await subscribeToPush(uid).catch(() => {})
  }

  // Handlers archivos crear
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setSelectedFiles((p) => [...p, ...files])
    setPreviews((p) => [...p, ...files.map((f) => URL.createObjectURL(f))])
    e.target.value = ""
  }
  const removeFile = (idx: number) => {
    URL.revokeObjectURL(previews[idx])
    setSelectedFiles((p) => p.filter((_, i) => i !== idx))
    setPreviews((p) => p.filter((_, i) => i !== idx))
  }
  const resetForm = () => {
    setFormNombre(""); setFormNotas(""); setFormFecha(hoy)
    previews.forEach((p) => URL.revokeObjectURL(p))
    setSelectedFiles([]); setPreviews([])
    setShowForm(false)
  }

  // Handlers archivos reenvío
  const handleResubmitFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setResubmitFiles((p) => [...p, ...files])
    setResubmitPreviews((p) => [...p, ...files.map((f) => URL.createObjectURL(f))])
    e.target.value = ""
  }
  const removeResubmitFile = (idx: number) => {
    URL.revokeObjectURL(resubmitPreviews[idx])
    setResubmitFiles((p) => p.filter((_, i) => i !== idx))
    setResubmitPreviews((p) => p.filter((_, i) => i !== idx))
  }
  const openResubmit = (informe: AdminInforme) => {
    setResubmitTarget(informe)
    setResubmitNombre(informe.nombre_reporte)
    setResubmitNotas(informe.notas ?? "")
    setResubmitFiles([]); setResubmitPreviews([])
  }
  const closeResubmit = () => {
    resubmitPreviews.forEach((p) => URL.revokeObjectURL(p))
    setResubmitTarget(null); setResubmitFiles([]); setResubmitPreviews([])
  }

  // Upload helper
  async function uploadFiles(files: File[]): Promise<{ url: string; nombre: string }[]> {
    const result: { url: string; nombre: string }[] = []
    for (const file of files) {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("folder", "admin-informes")
      const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
      const json = await res.json()
      if (json.url) result.push({ url: json.url, nombre: file.name })
    }
    return result
  }

  const handleCrear = async () => {
    if (!formNombre.trim()) return
    setSaving(true)
    try {
      const imgUrls = await uploadFiles(selectedFiles)
      const supabase = createClient()
      const { data: informe, error } = await supabase
        .from("admin_informes")
        .insert({
          admin_id: Number(currentUser.id),
          admin_nombre: currentUser.nombre,
          fecha: formFecha,
          nombre_reporte: formNombre.trim(),
          notas: formNotas.trim() || null,
          estado: "pendiente",
          version: 1,
        })
        .select("id")
        .single()
      if (error || !informe) throw new Error(error?.message ?? "Error al crear")
      if (imgUrls.length > 0) {
        await supabase.from("admin_informe_imagenes").insert(
          imgUrls.map(({ url, nombre }) => ({ admin_informe_id: informe.id, url_imagen: url, nombre_archivo: nombre }))
        )
      }
      fetch("/api/push/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Nuevo reporte de ${currentUser.nombre}`,
          body: formNombre.trim(),
          tag: `admin-informe-${informe.id}`,
          url: "/",
          rol: "secretaria",
        }),
      }).catch(() => {})
      setSelectedDate(formFecha)
      resetForm()
      const { data } = await supabase
        .from("admin_informes").select("*, admin_informe_imagenes(*)")
        .eq("admin_id", Number(uid)).eq("fecha", formFecha).order("created_at", { ascending: false })
      setInformes((data as AdminInforme[]) ?? [])
    } catch (e) {
      console.error("[v0] AdminReportes crear error:", e)
    } finally {
      setSaving(false)
    }
  }

  const handleReenviar = async () => {
    if (!resubmitTarget || !resubmitNombre.trim()) return
    setResubmitting(true)
    try {
      const imgUrls = await uploadFiles(resubmitFiles)
      const supabase = createClient()
      await supabase.from("admin_informes").update({
        estado: "pendiente",
        nombre_reporte: resubmitNombre.trim(),
        notas: resubmitNotas.trim() || null,
        version: resubmitTarget.version + 1,
        revision_secretaria_id: null,
        revision_secretaria_nombre: null,
        revision_comentario: null,
        revision_at: null,
        updated_at: new Date().toISOString(),
      }).eq("id", resubmitTarget.id)
      await supabase.from("admin_informe_imagenes").delete().eq("admin_informe_id", resubmitTarget.id)
      if (imgUrls.length > 0) {
        await supabase.from("admin_informe_imagenes").insert(
          imgUrls.map(({ url, nombre }) => ({ admin_informe_id: resubmitTarget.id, url_imagen: url, nombre_archivo: nombre }))
        )
      }
      fetch("/api/push/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Reporte actualizado — ${currentUser.nombre}`,
          body: resubmitNombre.trim(),
          tag: `admin-informe-${resubmitTarget.id}`,
          url: "/",
          rol: "secretaria",
        }),
      }).catch(() => {})
      closeResubmit()
      const { data } = await supabase
        .from("admin_informes").select("*, admin_informe_imagenes(*)")
        .eq("admin_id", Number(uid)).eq("fecha", selectedDate).order("created_at", { ascending: false })
      setInformes((data as AdminInforme[]) ?? [])
    } catch (e) {
      console.error("[v0] AdminReportes reenviar error:", e)
    } finally {
      setResubmitting(false)
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
            <h2 className="text-base md:text-xl font-bold">Reportes diarios</h2>
            <p className="text-xs text-muted-foreground">Mis reportes</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <div className="flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              type="date"
              value={selectedDate}
              max={hoy}
              onChange={(e) => { setSelectedDate(e.target.value); setShowForm(false) }}
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
          {!showForm && (
            <Button
              size="sm"
              onClick={() => { setShowForm(true); setFormFecha(selectedDate) }}
              className="gap-1 text-xs whitespace-nowrap"
            >
              <Plus className="h-4 w-4" /> Nuevo
            </Button>
          )}
        </div>
      </div>

      {/* Subtítulo */}
      <p className="text-sm font-medium capitalize text-muted-foreground">
        {esHoy ? "Hoy · " : ""}{fechaDisplay}
      </p>

      {/* Formulario nuevo reporte */}
      {showForm && (
        <Card className="border-primary/40">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm md:text-base">Nuevo reporte</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1 col-span-2 sm:col-span-1">
                <Label className="text-xs md:text-sm">Nombre del reporte <span className="text-red-500">*</span></Label>
                <Input
                  value={formNombre}
                  onChange={(e) => setFormNombre(e.target.value)}
                  placeholder="Ej: Informe de apertura..."
                  className="h-8 md:h-10 text-xs md:text-sm"
                  autoFocus
                />
              </div>
              <div className="space-y-1 col-span-2 sm:col-span-1">
                <Label className="text-xs md:text-sm">Fecha</Label>
                <Input
                  type="date"
                  value={formFecha}
                  onChange={(e) => setFormFecha(e.target.value)}
                  className="h-8 md:h-10 text-xs md:text-sm"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs md:text-sm">Notas / Comentarios</Label>
              <Textarea
                value={formNotas}
                onChange={(e) => setFormNotas(e.target.value)}
                placeholder="Descripción, observaciones..."
                rows={3}
                className="text-xs md:text-sm resize-none"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs md:text-sm">Imágenes</Label>
              {previews.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {previews.map((src, idx) => (
                    <div key={idx} className="relative group aspect-square rounded-md overflow-hidden border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src} alt="" className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeFile(idx)}
                        className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1 text-xs w-full"
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus className="h-4 w-4" /> Agregar imágenes
              </Button>
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={resetForm} disabled={saving}>
                Cancelar
              </Button>
              <Button
                size="sm"
                className="flex-1 text-xs"
                onClick={handleCrear}
                disabled={saving || !formNombre.trim()}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enviar a secretaria"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lista de reportes */}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : informes.length === 0 ? (
        <div className="text-center text-muted-foreground text-sm py-10">
          No hay reportes para este día.
        </div>
      ) : (
        <div className="space-y-3">
          {informes.map((inf) => (
            <Card
              key={inf.id}
              className={
                inf.estado === "rechazado"
                  ? "border-destructive/40"
                  : inf.estado === "aprobado"
                  ? "border-green-500/40"
                  : ""
              }
            >
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5 min-w-0">
                    <p className="font-semibold text-sm md:text-base truncate">{inf.nombre_reporte}</p>
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

                {/* Reporte rechazado: mostrar comentario y botón de corrección */}
                {inf.estado === "rechazado" && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 space-y-2">
                    <div className="flex items-center gap-1.5 text-destructive">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span className="text-xs font-semibold">
                        Rechazado por {inf.revision_secretaria_nombre ?? "secretaria"}
                      </span>
                    </div>
                    {inf.revision_comentario && (
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                        {inf.revision_comentario}
                      </p>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-xs gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => openResubmit(inf)}
                    >
                      Corregir y reenviar
                    </Button>
                  </div>
                )}

                {/* Reporte aprobado */}
                {inf.estado === "aprobado" && inf.revision_secretaria_nombre && (
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Aprobado por {inf.revision_secretaria_nombre}
                  </p>
                )}

                <p className="text-[10px] text-muted-foreground">
                  {new Date(inf.created_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                  {inf.admin_informe_imagenes.length > 0 && ` · ${inf.admin_informe_imagenes.length} imagen${inf.admin_informe_imagenes.length !== 1 ? "es" : ""}`}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Dialog: Corregir y reenviar */}
      <Dialog open={!!resubmitTarget} onOpenChange={(open) => { if (!open) closeResubmit() }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-lg">
          <h2 className="text-sm md:text-base font-bold mb-3">Corregir y reenviar</h2>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs md:text-sm">Nombre del reporte <span className="text-red-500">*</span></Label>
              <Input
                value={resubmitNombre}
                onChange={(e) => setResubmitNombre(e.target.value)}
                className="h-8 md:h-10 text-xs md:text-sm"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs md:text-sm">Notas / Comentarios</Label>
              <Textarea
                value={resubmitNotas}
                onChange={(e) => setResubmitNotas(e.target.value)}
                rows={3}
                className="text-xs md:text-sm resize-none"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs md:text-sm">Imágenes nuevas</Label>
              <p className="text-[10px] text-muted-foreground">
                Las imágenes anteriores serán reemplazadas por las nuevas que adjuntes.
              </p>
              {resubmitPreviews.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {resubmitPreviews.map((src, idx) => (
                    <div key={idx} className="relative group aspect-square rounded-md overflow-hidden border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src} alt="" className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeResubmitFile(idx)}
                        className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1 text-xs w-full"
                onClick={() => resubmitFileRef.current?.click()}
              >
                <ImagePlus className="h-4 w-4" /> Agregar imágenes
              </Button>
              <input ref={resubmitFileRef} type="file" accept="image/*" multiple className="hidden" onChange={handleResubmitFileChange} />
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1 h-8 md:h-10 text-xs" onClick={closeResubmit} disabled={resubmitting}>
                Cancelar
              </Button>
              <Button
                className="flex-1 h-8 md:h-10 text-xs"
                onClick={handleReenviar}
                disabled={resubmitting || !resubmitNombre.trim()}
              >
                {resubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reenviar a secretaria"}
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
