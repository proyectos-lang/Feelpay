"use client"

import { useState, useEffect, useRef, useMemo } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import {
  Plus,
  Loader2,
  Trash2,
  ImagePlus,
  X,
  ChevronDown,
  ChevronUp,
  CalendarDays,
  FileText,
  ShieldOff,
  ZoomIn,
  Pencil,
  Bell,
  BellRing,
} from "lucide-react"
import { DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { AuthenticatedUser } from "@/components/views/login-view"

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface InformeImagen {
  id: string
  url_imagen: string
  nombre_archivo: string | null
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
  informe_imagenes: InformeImagen[]
}

interface SecretaryReportsProps {
  currentRutaId: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fechaColombiaHoy(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date())
}

function formatFecha(dateStr: string): string {
  const [y, m, d] = dateStr.split("-")
  return `${d}/${m}/${y}`
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function SecretaryReports({ currentRutaId }: SecretaryReportsProps) {
  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null)
  const [accessChecked, setAccessChecked] = useState(false)
  const [hasAccess, setHasAccess] = useState(false)
  const [mode, setMode] = useState<"secretaria" | "gerencia" | "sin-acceso">("sin-acceso")

  // Leer currentUser desde localStorage y verificar acceso
  useEffect(() => {
    const raw = localStorage.getItem("currentUser")
    if (!raw) { setAccessChecked(true); return }
    try {
      const user: AuthenticatedUser = JSON.parse(raw)
      setCurrentUser(user)
      const rol = (user.rol ?? "").toLowerCase()

      if (rol === "gerencia") {
        setMode("gerencia")
        setHasAccess(true)
        setAccessChecked(true)
        return
      }

      if (rol === "secretaria" || rol === "secretario") {
        // Verificar acceso_modulo_reporte en la tabla usuarios
        const supabase = createClient()
        supabase
          .from("usuarios")
          .select("acceso_modulo_reporte")
          .eq("id", Number(user.id))
          .single()
          .then(({ data }) => {
            if (data?.acceso_modulo_reporte) {
              setMode("secretaria")
              setHasAccess(true)
            } else {
              setMode("sin-acceso")
              setHasAccess(false)
            }
            setAccessChecked(true)
          })
        return
      }

      setMode("sin-acceso")
      setHasAccess(false)
      setAccessChecked(true)
    } catch {
      setAccessChecked(true)
    }
  }, [])

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center h-60">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!hasAccess) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-60 text-muted-foreground">
        <ShieldOff className="h-10 w-10" />
        <p className="text-sm font-medium">Sin acceso al módulo de Reportes</p>
      </div>
    )
  }

  if (mode === "gerencia") {
    return <GerenciaView />
  }

  return <SecretariaView currentUser={currentUser!} currentRutaId={currentRutaId} />
}

// ─── Vista Secretaria ─────────────────────────────────────────────────────────

function SecretariaView({
  currentUser,
  currentRutaId,
}: {
  currentUser: AuthenticatedUser
  currentRutaId: number
}) {
  const hoy = fechaColombiaHoy()
  const [viewDate, setViewDate] = useState(hoy)
  const [informes, setInformes] = useState<Informe[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formNombre, setFormNombre] = useState("")
  const [formNotas, setFormNotas] = useState("")
  const [formFecha, setFormFecha] = useState(hoy)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [editingInforme, setEditingInforme] = useState<Informe | null>(null)
  const [editNombre, setEditNombre] = useState("")
  const [editNotas, setEditNotas] = useState("")
  const [savingEdit, setSavingEdit] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchInformes = async (fecha: string) => {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from("informes")
        .select("*, informe_imagenes(*)")
        .eq("secretaria_id", Number(currentUser.id))
        .eq("fecha", fecha)
        .order("created_at", { ascending: false })
      setInformes((data as Informe[]) ?? [])
    } catch (e) {
      console.error("[v0] SecretariaView fetchInformes error:", e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void fetchInformes(viewDate) }, [viewDate])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setSelectedFiles((prev) => [...prev, ...files])
    const newPreviews = files.map((f) => URL.createObjectURL(f))
    setPreviews((prev) => [...prev, ...newPreviews])
    e.target.value = ""
  }

  const removeFile = (idx: number) => {
    URL.revokeObjectURL(previews[idx])
    setSelectedFiles((prev) => prev.filter((_, i) => i !== idx))
    setPreviews((prev) => prev.filter((_, i) => i !== idx))
  }

  const resetForm = () => {
    setFormNombre("")
    setFormNotas("")
    setFormFecha(hoy)
    previews.forEach((p) => URL.revokeObjectURL(p))
    setSelectedFiles([])
    setPreviews([])
    setShowForm(false)
  }

  const handleCrearReporte = async () => {
    if (!formNombre.trim()) return
    setSaving(true)
    try {
      // 1. Subir imágenes a Vercel Blob
      const urls: { url: string; nombre: string }[] = []
      for (const file of selectedFiles) {
        const fd = new FormData()
        fd.append("file", file)
        fd.append("folder", "informes")
        const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
        const json = await res.json()
        if (json.url) urls.push({ url: json.url, nombre: file.name })
      }

      // 2. Insertar cabecera del informe
      const supabase = createClient()
      const { data: informe, error: errInforme } = await supabase
        .from("informes")
        .insert({
          secretaria_id: Number(currentUser.id),
          secretaria_nombre: currentUser.nombre,
          ruta_id: currentRutaId,
          fecha: formFecha,
          nombre_reporte: formNombre.trim(),
          notas: formNotas.trim() || null,
        })
        .select("id")
        .single()

      if (errInforme || !informe) throw new Error(errInforme?.message ?? "Error al crear reporte")

      // 3. Insertar imágenes
      if (urls.length > 0) {
        await supabase.from("informe_imagenes").insert(
          urls.map(({ url, nombre }) => ({
            informe_id: informe.id,
            url_imagen: url,
            nombre_archivo: nombre,
          }))
        )
      }

      // Sincronizar la vista al día del reporte recién creado
      setViewDate(formFecha)
      resetForm()
      void fetchInformes(formFecha)
    } catch (e) {
      console.error("[v0] handleCrearReporte error:", e)
    } finally {
      setSaving(false)
    }
  }

  const handleEditSave = async () => {
    if (!editingInforme || !editNombre.trim()) return
    setSavingEdit(true)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from("informes")
        .update({ nombre_reporte: editNombre.trim(), notas: editNotas.trim() || null })
        .eq("id", editingInforme.id)
      if (!error) {
        setInformes((prev) =>
          prev.map((i) =>
            i.id === editingInforme.id
              ? { ...i, nombre_reporte: editNombre.trim(), notas: editNotas.trim() || null }
              : i
          )
        )
        setEditingInforme(null)
      }
    } catch (e) {
      console.error("[v0] handleEditSave error:", e)
    } finally {
      setSavingEdit(false)
    }
  }

  const handleEliminarConfirm = async () => {
    if (!confirmDeleteId) return
    const id = confirmDeleteId
    setConfirmDeleteId(null)
    setDeleting(id)
    try {
      const supabase = createClient()
      await supabase.from("informes").delete().eq("id", id)
      setInformes((prev) => prev.filter((i) => i.id !== id))
    } catch (e) {
      console.error("[v0] handleEliminar error:", e)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-2xl mx-auto">
      {/* Encabezado */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 flex-1">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-border overflow-hidden p-0.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
          </div>
          <h2 className="text-base md:text-xl font-bold">Mis reportes</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              type="date"
              value={viewDate}
              max={hoy}
              onChange={(e) => { setViewDate(e.target.value); setShowForm(false) }}
              className="h-8 md:h-9 text-xs md:text-sm w-36"
            />
          </div>
          {!showForm && (
            <Button size="sm" onClick={() => { setShowForm(true); setFormFecha(viewDate) }} className="gap-1 text-xs md:text-sm whitespace-nowrap">
              <Plus className="h-4 w-4" /> Nuevo
            </Button>
          )}
        </div>
      </div>

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
                <Label className="text-xs md:text-sm">Fecha del reporte</Label>
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

            {/* Selector de imágenes */}
            <div className="space-y-2">
              <Label className="text-xs md:text-sm">Imágenes adjuntas</Label>
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
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={resetForm} disabled={saving}>
                Cancelar
              </Button>
              <Button
                size="sm"
                className="flex-1 text-xs"
                onClick={handleCrearReporte}
                disabled={saving || !formNombre.trim()}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar reporte"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lista de reportes del día */}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : informes.length === 0 ? (
        <div className="text-center text-muted-foreground text-sm py-10">
          No hay reportes para el {formatFecha(viewDate)}.
        </div>
      ) : (
        <div className="space-y-3">
          {informes.map((inf) => (
            <Card key={inf.id}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5 min-w-0">
                    <p className="font-semibold text-sm md:text-base truncate">{inf.nombre_reporte}</p>
                    {inf.notas && (
                      <p className="text-xs md:text-sm text-muted-foreground whitespace-pre-wrap">{inf.notas}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(inf.created_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                      {" · "}
                      {inf.informe_imagenes.length} imagen{inf.informe_imagenes.length !== 1 ? "es" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                      onClick={() => { setEditingInforme(inf); setEditNombre(inf.nombre_reporte); setEditNotas(inf.notas ?? "") }}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:bg-destructive/10"
                      onClick={() => setConfirmDeleteId(inf.id)}
                      disabled={deleting === inf.id}
                    >
                      {deleting === inf.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    </Button>
                  </div>
                </div>
                {inf.informe_imagenes.length > 0 && (
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    {inf.informe_imagenes.map((img) => (
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Editar reporte */}
      <Dialog open={!!editingInforme} onOpenChange={(open) => { if (!open) setEditingInforme(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-base">Editar reporte</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs md:text-sm">Nombre del reporte <span className="text-red-500">*</span></Label>
              <Input
                value={editNombre}
                onChange={(e) => setEditNombre(e.target.value)}
                className="h-8 md:h-10 text-xs md:text-sm"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs md:text-sm">Notas / Comentarios</Label>
              <Textarea
                value={editNotas}
                onChange={(e) => setEditNotas(e.target.value)}
                rows={3}
                className="text-xs md:text-sm resize-none"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1 h-8 md:h-10 text-xs" onClick={() => setEditingInforme(null)} disabled={savingEdit}>
                Cancelar
              </Button>
              <Button className="flex-1 h-8 md:h-10 text-xs" onClick={handleEditSave} disabled={savingEdit || !editNombre.trim()}>
                {savingEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmar eliminación */}
      <Dialog open={!!confirmDeleteId} onOpenChange={(open) => { if (!open) setConfirmDeleteId(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-sm">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                <Trash2 className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <p className="font-semibold text-sm md:text-base">¿Eliminar reporte?</p>
                <p className="text-xs md:text-sm text-muted-foreground">Se eliminarán también todas las imágenes adjuntas. Esta acción no se puede deshacer.</p>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1 h-8 md:h-10 text-xs md:text-sm" onClick={() => setConfirmDeleteId(null)}>
                Cancelar
              </Button>
              <Button variant="destructive" className="flex-1 h-8 md:h-10 text-xs md:text-sm" onClick={handleEliminarConfirm}>
                Sí, eliminar
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

// ─── Vista Gerencia ───────────────────────────────────────────────────────────

interface AgrupacionSecretaria {
  secretaria_id: number
  secretaria_nombre: string
  reportes: Informe[]
}

const DIAS_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]

function GerenciaView() {
  const hoy = fechaColombiaHoy()
  const [endDate, setEndDate] = useState(hoy)
  const [allData, setAllData] = useState<Record<string, AgrupacionSecretaria[]>>({})
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [lightbox, setLightbox] = useState<string | null>(null)

  // ── Notificaciones ────────────────────────────────────────────────────────
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">("default")
  const [newCount, setNewCount] = useState(0)
  const [banner, setBanner] = useState<{ nombre: string; reporte: string } | null>(null)
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref para que el callback realtime acceda a `days` sin re-suscribirse
  const daysRef = useRef<string[]>([])

  // Genera los 3 días (newest first) que terminan en endDate
  const days = useMemo(() => {
    const [y, m, d] = endDate.split("-").map(Number)
    const base = new Date(y, m - 1, d)
    return Array.from({ length: 3 }, (_, i) => {
      const dt = new Date(base)
      dt.setDate(base.getDate() - i)
      const yy = dt.getFullYear()
      const mm = String(dt.getMonth() + 1).padStart(2, "0")
      const dd = String(dt.getDate()).padStart(2, "0")
      return `${yy}-${mm}-${dd}`
    })
  }, [endDate])

  // Mantener ref sincronizada
  useEffect(() => { daysRef.current = days }, [days])

  // Detectar soporte y permiso actual de notificaciones
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setNotifPermission("unsupported")
    } else {
      setNotifPermission(Notification.permission)
    }
  }, [])

  // Suscripción Realtime — se crea una sola vez al montar
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel("gerencia-informes-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "informes" },
        (payload) => {
          const raw = payload.new as {
            id: string
            secretaria_id: number
            secretaria_nombre: string
            fecha: string
            nombre_reporte: string
            notas: string | null
            ruta_id: number | null
            created_at: string
          }

          // Notificación nativa del navegador
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification(`Nuevo reporte — ${raw.secretaria_nombre}`, {
              body: raw.nombre_reporte,
              icon: "/opad-logo.png",
              tag: `informe-${raw.id}`,
            })
          }

          // Banner in-app (se auto-cierra en 7 s)
          setNewCount((c) => c + 1)
          if (bannerTimer.current) clearTimeout(bannerTimer.current)
          setBanner({ nombre: raw.secretaria_nombre, reporte: raw.nombre_reporte })
          bannerTimer.current = setTimeout(() => setBanner(null), 7000)

          // Actualizar columna si la fecha está en la ventana actual
          if (daysRef.current.includes(raw.fecha)) {
            supabase
              .from("informes")
              .select("*, informe_imagenes(*)")
              .eq("id", raw.id)
              .single()
              .then(({ data }) => {
                if (!data) return
                const fullInf = data as Informe
                setAllData((prev) => {
                  const dateGroups = [...(prev[fullInf.fecha] ?? [])]
                  const grpIdx = dateGroups.findIndex((g) => g.secretaria_id === fullInf.secretaria_id)
                  if (grpIdx >= 0) {
                    dateGroups[grpIdx] = { ...dateGroups[grpIdx], reportes: [...dateGroups[grpIdx].reportes, fullInf] }
                  } else {
                    dateGroups.push({ secretaria_id: fullInf.secretaria_id, secretaria_nombre: fullInf.secretaria_nombre, reportes: [fullInf] })
                  }
                  return { ...prev, [fullInf.fecha]: dateGroups }
                })
              })
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      if (bannerTimer.current) clearTimeout(bannerTimer.current)
    }
  }, [])

  // Carga inicial y al cambiar ventana de fechas
  useEffect(() => {
    const oldest = days[days.length - 1]
    const newest = days[0]
    setLoading(true)
    setExpanded(new Set())
    const supabase = createClient()
    supabase
      .from("informes")
      .select("*, informe_imagenes(*)")
      .gte("fecha", oldest)
      .lte("fecha", newest)
      .order("secretaria_nombre", { ascending: true })
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error) { console.error("[v0] GerenciaView fetch error:", error); setLoading(false); return }
        const rows = (data as Informe[]) ?? []
        const result: Record<string, AgrupacionSecretaria[]> = {}
        for (const inf of rows) {
          if (!result[inf.fecha]) result[inf.fecha] = []
          const grp = result[inf.fecha].find(g => g.secretaria_id === inf.secretaria_id)
          if (grp) { grp.reportes.push(inf) }
          else { result[inf.fecha].push({ secretaria_id: inf.secretaria_id, secretaria_nombre: inf.secretaria_nombre, reportes: [inf] }) }
        }
        setAllData(result)
        setLoading(false)
      })
  }, [days])

  const toggleExpanded = (key: string) =>
    setExpanded(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  const requestPermission = async () => {
    if (!("Notification" in window)) return
    const result = await Notification.requestPermission()
    setNotifPermission(result)
  }

  return (
    <div className="p-3 md:p-6 space-y-4">
      {/* Encabezado */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 flex-1">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-border overflow-hidden p-0.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
          </div>
          <h2 className="text-base md:text-xl font-bold">Reportes de secretarias</h2>
        </div>
        <div className="flex items-center gap-2">
          {endDate !== hoy && (
            <Button size="sm" variant="outline" onClick={() => setEndDate(hoy)} className="h-8 text-xs px-3">
              Hoy
            </Button>
          )}
          <div className="flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              type="date"
              value={endDate}
              max={hoy}
              onChange={(e) => { if (e.target.value) setEndDate(e.target.value) }}
              className="h-8 text-xs w-36"
            />
          </div>
          {/* Botón notificaciones */}
          {notifPermission !== "unsupported" && (
            notifPermission === "granted" ? (
              <button
                type="button"
                title="Notificaciones activas"
                onClick={() => setNewCount(0)}
                className="relative flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card hover:bg-muted transition-colors"
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
                title={notifPermission === "denied" ? "Notificaciones bloqueadas en el navegador" : "Activar notificaciones"}
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

      {/* Banner in-app para reportes nuevos */}
      {banner && (
        <div className="flex items-center gap-3 rounded-lg border border-brand/30 bg-brand/10 px-4 py-2.5 text-sm">
          <BellRing className="h-4 w-4 shrink-0 animate-pulse text-brand" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold">Nuevo reporte</span>
            <span className="text-muted-foreground"> · {banner.nombre}</span>
            <span className="text-muted-foreground"> — </span>
            <span className="truncate">{banner.reporte}</span>
          </div>
          <button type="button" onClick={() => setBanner(null)} className="shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Timeline — scroll horizontal en móvil, grid en escritorio */}
      {loading ? (
        <div className="flex justify-center py-14">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        /* En móvil: carrusel con snap. En escritorio: grid de 3 columnas */
        <div className="
          flex gap-3 overflow-x-auto snap-x snap-mandatory pb-4 -mx-3 px-3
          md:grid md:grid-cols-3 md:gap-4 md:overflow-visible md:snap-none md:pb-0 md:mx-0 md:px-0
        ">
          {days.map((fecha) => {
            const [y, m, d] = fecha.split("-").map(Number)
            const dateObj = new Date(y, m - 1, d)
            const isToday = fecha === hoy
            const grupos = allData[fecha] ?? []
            const totalReportes = grupos.reduce((s, g) => s + g.reportes.length, 0)

            return (
              /* Móvil: 82 vw para que asome el siguiente día. Escritorio: ocupa la celda del grid */
              <div key={fecha} className="snap-start shrink-0 w-[82vw] sm:w-[68vw] flex flex-col gap-2 md:w-auto md:min-w-0">

                {/* Cabecera del día */}
                <div className={`rounded-xl px-4 py-4 text-center select-none ${
                  isToday
                    ? "bg-brand text-brand-foreground shadow-md"
                    : "bg-muted/70 text-foreground"
                }`}>
                  <div className="text-xs font-bold uppercase tracking-widest opacity-75">
                    {isToday ? "HOY" : DIAS_ES[dateObj.getDay()]}
                  </div>
                  <div className="text-5xl font-extrabold leading-none mt-1 md:text-4xl">
                    {String(d).padStart(2, "0")}
                  </div>
                  <div className="text-xs opacity-60 mt-1">
                    {String(m).padStart(2, "0")}/{y}
                  </div>
                  {totalReportes > 0 && (
                    <div className={`mt-2 text-xs font-semibold px-2.5 py-0.5 rounded-full inline-block ${
                      isToday ? "bg-white/20" : "bg-foreground/10"
                    }`}>
                      {totalReportes} reporte{totalReportes !== 1 ? "s" : ""}
                    </div>
                  )}
                </div>

                {/* Secretarias de este día */}
                {grupos.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-sm text-muted-foreground/60 border border-dashed rounded-lg">
                    Sin reportes
                  </div>
                ) : (
                  <div className="space-y-2">
                    {grupos.map((grupo) => {
                      const key = `${fecha}-${grupo.secretaria_id}`
                      const isExp = expanded.has(key)
                      return (
                        <Card key={grupo.secretaria_id} className="overflow-hidden">
                          {/* Acordeón: cabecera */}
                          <button
                            type="button"
                            className="w-full text-left"
                            onClick={() => toggleExpanded(key)}
                          >
                            <div className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-muted/40 transition-colors">
                              <div className="flex items-center gap-2 min-w-0">
                                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <p className="font-semibold text-sm leading-tight truncate">
                                  {grupo.secretaria_nombre}
                                </p>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <Badge variant="secondary" className="text-xs px-1.5 py-0">
                                  {grupo.reportes.length}
                                </Badge>
                                {isExp
                                  ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                                  : <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                }
                              </div>
                            </div>
                          </button>

                          {/* Acordeón: contenido desplegado */}
                          {isExp && (
                            <div className="border-t divide-y divide-border/60">
                              {grupo.reportes.map((inf) => (
                                <div key={inf.id} className="px-4 py-3 space-y-2.5">
                                  <p className="font-semibold text-sm leading-snug">
                                    {inf.nombre_reporte}
                                  </p>
                                  {inf.notas && (
                                    <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-snug">
                                      {inf.notas}
                                    </p>
                                  )}
                                  {inf.informe_imagenes.length > 0 && (
                                    /* 2 columnas en móvil, 3 en escritorio — imágenes más grandes */
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 pt-0.5">
                                      {inf.informe_imagenes.map((img) => (
                                        <button
                                          key={img.id}
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); setLightbox(img.url_imagen) }}
                                          className="relative aspect-square rounded-lg overflow-hidden border hover:opacity-90 transition-opacity group"
                                        >
                                          {/* eslint-disable-next-line @next/next/no-img-element */}
                                          <img
                                            src={img.url_imagen}
                                            alt={img.nombre_archivo ?? ""}
                                            className="w-full h-full object-cover"
                                          />
                                          <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/25 transition-colors">
                                            <ZoomIn className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  <p className="text-xs text-muted-foreground/70">
                                    {new Intl.DateTimeFormat("es-CO", {
                                      timeZone: "America/Bogota",
                                      hour: "2-digit", minute: "2-digit", hour12: true,
                                    }).format(new Date(inf.created_at))}
                                    {inf.informe_imagenes.length > 0 && ` · ${inf.informe_imagenes.length} img`}
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                        </Card>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

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
