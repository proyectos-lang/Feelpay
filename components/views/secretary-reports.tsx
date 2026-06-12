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

function GerenciaView() {
  const hoy = fechaColombiaHoy()
  const [selectedDate, setSelectedDate] = useState(hoy)
  const [agrupados, setAgrupados] = useState<AgrupacionSecretaria[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  const fetchReportes = async (fecha: string) => {
    setLoading(true)
    setExpanded(null)
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from("informes")
        .select("*, informe_imagenes(*)")
        .eq("fecha", fecha)
        .order("secretaria_nombre", { ascending: true })
        .order("created_at", { ascending: true })

      const rows = (data as Informe[]) ?? []

      // Agrupar por secretaria_id
      const map = new Map<number, AgrupacionSecretaria>()
      for (const inf of rows) {
        if (!map.has(inf.secretaria_id)) {
          map.set(inf.secretaria_id, {
            secretaria_id: inf.secretaria_id,
            secretaria_nombre: inf.secretaria_nombre,
            reportes: [],
          })
        }
        map.get(inf.secretaria_id)!.reportes.push(inf)
      }
      setAgrupados(Array.from(map.values()))
    } catch (e) {
      console.error("[v0] GerenciaView fetchReportes error:", e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void fetchReportes(selectedDate) }, [selectedDate])

  return (
    <div className="p-3 md:p-6 space-y-4 max-w-3xl mx-auto">
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
          <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            type="date"
            value={selectedDate}
            max={hoy}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="h-8 md:h-9 text-xs md:text-sm w-40"
          />
        </div>
      </div>

      {/* Contenido */}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : agrupados.length === 0 ? (
        <div className="text-center text-muted-foreground text-sm py-10">
          No hay reportes para el {formatFecha(selectedDate)}.
        </div>
      ) : (
        <div className="space-y-3">
          {agrupados.map((grupo) => (
            <Card key={grupo.secretaria_id} className="overflow-hidden">
              {/* Cabecera clickeable */}
              <button
                type="button"
                className="w-full text-left"
                onClick={() => setExpanded(expanded === grupo.secretaria_id ? null : grupo.secretaria_id)}
              >
                <CardHeader className="py-3 px-4 hover:bg-muted/40 transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="font-semibold text-sm md:text-base truncate">{grupo.secretaria_nombre}</p>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {grupo.reportes.length} reporte{grupo.reportes.length !== 1 ? "s" : ""}
                      </Badge>
                    </div>
                    {expanded === grupo.secretaria_id
                      ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
                      : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    }
                  </div>
                </CardHeader>
              </button>

              {/* Reportes desplegados */}
              {expanded === grupo.secretaria_id && (
                <CardContent className="px-4 pb-4 pt-0 space-y-4">
                  <div className="border-t pt-3 space-y-4">
                    {grupo.reportes.map((inf) => (
                      <div key={inf.id} className="space-y-2">
                        <div>
                          <p className="font-medium text-sm">{inf.nombre_reporte}</p>
                          {inf.notas && (
                            <p className="text-xs text-muted-foreground whitespace-pre-wrap mt-0.5">{inf.notas}</p>
                          )}
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {new Date(inf.created_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                            {" · "}
                            {inf.informe_imagenes.length} imagen{inf.informe_imagenes.length !== 1 ? "es" : ""}
                          </p>
                        </div>
                        {inf.informe_imagenes.length > 0 && (
                          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
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
                        {/* Separador entre reportes (excepto el último) */}
                        {inf !== grupo.reportes[grupo.reportes.length - 1] && (
                          <div className="border-t border-dashed" />
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
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
