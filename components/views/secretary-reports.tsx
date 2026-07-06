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
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  FileText,
  ShieldOff,
  ZoomIn,
  Pencil,
  Bell,
  BellRing,
  MessageSquare,
  FileSpreadsheet,
  Download,
} from "lucide-react"
import { DialogHeader, DialogTitle } from "@/components/ui/dialog"
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
  const [lightbox, setLightbox] = useState<{ urls: string[]; idx: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [destinatario, setDestinatario] = useState<"gerencia" | "socioadmin">("gerencia")
  const [socioadminId, setSocioadminId] = useState<number | null>(null)
  const [socioadmins, setSocioadmins] = useState<{ id: number; nombre: string }[]>([])
  const [excelFiles, setExcelFiles] = useState<File[]>([])
  const [excelError, setExcelError] = useState<string | null>(null)
  const excelInputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from("usuarios")
      .select("id, nombre")
      .eq("rol", "socioadmin")
      .eq("activo", true)
      .order("nombre")
      .then(({ data }) => {
        setSocioadmins((data as { id: number; nombre: string }[]) ?? [])
      })
  }, [])

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

  const handleExcelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const MAX_SIZE = 25 * 1024 * 1024
    const oversized = files.filter((f) => f.size > MAX_SIZE)
    if (oversized.length > 0) {
      setExcelError(`"${oversized[0].name}" supera el límite de 25 MB`)
      e.target.value = ""; return
    }
    setExcelError(null)
    setExcelFiles((prev) => [...prev, ...files])
    e.target.value = ""
  }

  const removeExcel = (idx: number) => {
    setExcelFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  const resetForm = () => {
    setFormNombre("")
    setFormNotas("")
    setFormFecha(hoy)
    previews.forEach((p) => URL.revokeObjectURL(p))
    setSelectedFiles([])
    setPreviews([])
    setDestinatario("gerencia")
    setSocioadminId(null)
    setExcelFiles([])
    setExcelError(null)
    setShowForm(false)
  }

  const handleCrearReporte = async () => {
    if (!formNombre.trim()) return
    if (destinatario === "socioadmin" && !socioadminId) return
    setSaving(true)
    try {
      // 1. Subir imágenes a Vercel Blob
      const imgUrls: { url: string; nombre: string }[] = []
      for (const file of selectedFiles) {
        const fd = new FormData()
        fd.append("file", file)
        fd.append("folder", "informes")
        const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
        const json = await res.json()
        if (json.url) imgUrls.push({ url: json.url, nombre: file.name })
      }

      // 2. Subir archivos Excel a Vercel Blob
      const excelUrls: { url: string; nombre: string }[] = []
      for (const file of excelFiles) {
        const fd = new FormData()
        fd.append("file", file)
        fd.append("folder", "informes")
        const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
        const json = await res.json()
        if (json.url) excelUrls.push({ url: json.url, nombre: file.name })
      }

      // 3. Insertar cabecera del informe
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
          destinatario,
          socioadmin_id: destinatario === "socioadmin" ? socioadminId : null,
        })
        .select("id")
        .single()

      if (errInforme || !informe) throw new Error(errInforme?.message ?? "Error al crear reporte")

      // 4. Insertar adjuntos (imágenes + Excel)
      const adjuntos = [
        ...imgUrls.map(({ url, nombre }) => ({ informe_id: informe.id, url_imagen: url, nombre_archivo: nombre, tipo: "imagen" as const })),
        ...excelUrls.map(({ url, nombre }) => ({ informe_id: informe.id, url_imagen: url, nombre_archivo: nombre, tipo: "archivo" as const })),
      ]
      if (adjuntos.length > 0) {
        await supabase.from("informe_imagenes").insert(adjuntos)
      }

      // 5. Notificar vía Web Push (fire-and-forget)
      fetch("/api/push/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          destinatario === "socioadmin"
            ? { title: `Nuevo reporte — ${currentUser.nombre}`, body: formNombre.trim(), tag: `informe-${informe.id}`, url: "/", user_id: socioadminId }
            : { title: `Nuevo reporte — ${currentUser.nombre}`, body: formNombre.trim(), tag: `informe-${informe.id}`, url: "/" }
        ),
      }).catch(() => {})

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
            {/* Destinatario */}
            <div className="space-y-1">
              <Label className="text-xs md:text-sm">Dirigido a</Label>
              <div className="flex rounded-md border overflow-hidden divide-x">
                <button
                  type="button"
                  onClick={() => { setDestinatario("gerencia"); setSocioadminId(null) }}
                  className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                    destinatario === "gerencia" ? "bg-brand text-brand-foreground" : "bg-card text-muted-foreground hover:bg-muted"
                  }`}
                >
                  Gerencia
                </button>
                <button
                  type="button"
                  onClick={() => setDestinatario("socioadmin")}
                  className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                    destinatario === "socioadmin" ? "bg-brand text-brand-foreground" : "bg-card text-muted-foreground hover:bg-muted"
                  }`}
                >
                  Socio Admin
                </button>
              </div>
            </div>

            {/* Selector de Socio Admin */}
            {destinatario === "socioadmin" && (
              <div className="space-y-1">
                <Label className="text-xs md:text-sm">Socio Administrador <span className="text-red-500">*</span></Label>
                <select
                  value={socioadminId ?? ""}
                  onChange={(e) => setSocioadminId(e.target.value ? Number(e.target.value) : null)}
                  className="h-8 md:h-10 text-xs md:text-sm w-full rounded-md border border-input bg-background px-3"
                >
                  <option value="">— Seleccionar —</option>
                  {socioadmins.map((sa) => (
                    <option key={sa.id} value={sa.id}>{sa.nombre}</option>
                  ))}
                </select>
              </div>
            )}

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

            {/* Archivos Excel */}
            <div className="space-y-2">
              <Label className="text-xs md:text-sm">Archivos Excel (.xlsx, .xls, .csv)</Label>
              {excelError && <p className="text-xs text-destructive">{excelError}</p>}
              {excelFiles.length > 0 && (
                <div className="space-y-1.5">
                  {excelFiles.map((f, idx) => (
                    <div key={idx} className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                      <FileSpreadsheet className="h-4 w-4 shrink-0 text-green-600" />
                      <span className="flex-1 text-xs truncate min-w-0">{f.name}</span>
                      <button type="button" onClick={() => removeExcel(idx)} className="text-muted-foreground hover:text-foreground">
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
                onClick={() => excelInputRef.current?.click()}
              >
                <Download className="h-4 w-4" /> Agregar Excel
              </Button>
              <input
                ref={excelInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                multiple
                className="hidden"
                onChange={handleExcelChange}
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
                disabled={saving || !formNombre.trim() || (destinatario === "socioadmin" && !socioadminId)}
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
                      <div className="flex items-start gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 mt-1">
                        <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground mt-0.5" />
                        <p className="text-xs md:text-sm text-muted-foreground whitespace-pre-wrap">{inf.notas}</p>
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(inf.created_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                      {(() => {
                        const imgs = inf.informe_imagenes.filter((a) => a.tipo !== "archivo").length
                        const docs = inf.informe_imagenes.filter((a) => a.tipo === "archivo").length
                        const parts = []
                        if (imgs > 0) parts.push(`${imgs} imagen${imgs !== 1 ? "es" : ""}`)
                        if (docs > 0) parts.push(`${docs} archivo${docs !== 1 ? "s" : ""}`)
                        return parts.length > 0 ? ` · ${parts.join(" · ")}` : ""
                      })()}
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
                {inf.informe_imagenes.filter((a) => a.tipo !== "archivo").length > 0 && (
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    {inf.informe_imagenes.filter((a) => a.tipo !== "archivo").map((img, imgIdx, imgArr) => (
                      <button
                        key={img.id}
                        type="button"
                        onClick={() => setLightbox({ urls: imgArr.map((a) => a.url_imagen), idx: imgIdx })}
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
                {inf.informe_imagenes.filter((a) => a.tipo === "archivo").length > 0 && (
                  <div className="space-y-1 pt-1">
                    {inf.informe_imagenes.filter((a) => a.tipo === "archivo").map((arch) => (
                      <div key={arch.id} className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
                        <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-green-600" />
                        <span className="flex-1 text-xs truncate min-w-0">{arch.nombre_archivo ?? "Archivo"}</span>
                      </div>
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
            <div className="relative flex items-center justify-center select-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={lightbox.urls[lightbox.idx]} alt="Imagen ampliada" className="w-full h-auto max-h-[85vh] object-contain rounded" />
              {lightbox.urls.length > 1 && (
                <>
                  <button type="button" onClick={() => setLightbox({ urls: lightbox.urls, idx: (lightbox.idx - 1 + lightbox.urls.length) % lightbox.urls.length })}
                    className="absolute left-1 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors">
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button type="button" onClick={() => setLightbox({ urls: lightbox.urls, idx: (lightbox.idx + 1) % lightbox.urls.length })}
                    className="absolute right-1 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors">
                    <ChevronRight className="h-5 w-5" />
                  </button>
                  <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
                    {lightbox.urls.map((_, i) => (
                      <button key={i} type="button" onClick={() => setLightbox({ urls: lightbox.urls, idx: i })}
                        className={`h-1.5 rounded-full transition-all ${i === lightbox.idx ? "w-4 bg-white" : "w-1.5 bg-white/40"}`} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Vista Gerencia ───────────────────────────────────────────────────────────

// Convierte la clave VAPID de base64url a Uint8Array (requerido por PushManager.subscribe)
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

interface AgrupacionSecretaria {
  secretaria_id: number
  secretaria_nombre: string
  reportes: Informe[]
}


function GerenciaView() {
  const hoy = fechaColombiaHoy()
  const [selectedDate, setSelectedDate] = useState(hoy)
  const selectedDateRef = useRef(hoy)
  const [grupos, setGrupos] = useState<AgrupacionSecretaria[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [lightbox, setLightbox] = useState<{ urls: string[]; idx: number } | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [tab, setTab] = useState<"reportes">("reportes")

  // ── Notificaciones ────────────────────────────────────────────────────────
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">("default")
  const [newCount, setNewCount] = useState(0)
  const [banner, setBanner] = useState<{ nombre: string; reporte: string } | null>(null)
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mantener ref sincronizada con selectedDate para el callback realtime
  useEffect(() => { selectedDateRef.current = selectedDate }, [selectedDate])

  // Detectar soporte, permiso actual y user_id; auto-suscribir si ya hay permiso
  useEffect(() => {
    if (typeof window === "undefined") return
    const raw = localStorage.getItem("currentUser")
    const uid = raw ? (JSON.parse(raw) as { id: string | number }).id : null
    setUserId(uid ? String(uid) : null)

    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setNotifPermission("unsupported"); return
    }
    setNotifPermission(Notification.permission)
    if (Notification.permission === "granted" && uid) {
      subscribeToPush(String(uid)).catch(() => {})
    }
  }, [])

  // Carga de reportes al cambiar de fecha
  useEffect(() => {
    setLoading(true)
    setExpanded(new Set())
    const supabase = createClient()
    supabase
      .from("informes")
      .select("*, informe_imagenes(*)")
      .eq("destinatario", "gerencia")
      .eq("fecha", selectedDate)
      .order("secretaria_nombre", { ascending: true })
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error) { console.error("[v0] GerenciaView fetch error:", error); setLoading(false); return }
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
  }, [selectedDate])

  // Suscripción Realtime — actualiza estado si la fecha seleccionada coincide
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel("gerencia-informes-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "informes" },
        (payload) => {
          const raw = payload.new as {
            id: string; secretaria_id: number; secretaria_nombre: string
            fecha: string; nombre_reporte: string; notas: string | null
            ruta_id: number | null; created_at: string
            destinatario?: string
          }

          // Ignorar informes dirigidos a socioadmin
          if (raw.destinatario && raw.destinatario !== "gerencia") return

          // Notificación nativa siempre (independiente del día seleccionado)
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification(`Nuevo reporte — ${raw.secretaria_nombre}`, {
              body: raw.nombre_reporte, icon: "/opad-logo.png", tag: `informe-${raw.id}`,
            })
          }

          // Banner in-app siempre
          setNewCount((c) => c + 1)
          if (bannerTimer.current) clearTimeout(bannerTimer.current)
          setBanner({ nombre: raw.secretaria_nombre, reporte: raw.nombre_reporte })
          bannerTimer.current = setTimeout(() => setBanner(null), 7000)

          // Actualizar lista solo si el reporte es del día que se está viendo
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
  }, [])

  useEffect(() => {
    if (!lightbox || lightbox.urls.length <= 1) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft")  setLightbox(p => p ? { urls: p.urls, idx: (p.idx - 1 + p.urls.length) % p.urls.length } : null)
      if (e.key === "ArrowRight") setLightbox(p => p ? { urls: p.urls, idx: (p.idx + 1) % p.urls.length } : null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [lightbox])

  const toggle = (id: number) =>
    setExpanded(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })

  async function subscribeToPush(uid: string) {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    if (!vapidKey) { console.error("[v0] VAPID public key no configurada"); return }

    const reg = await navigator.serviceWorker.ready

    // PushManager.subscribe requiere Uint8Array, no un string plano
    let existing = await reg.pushManager.getSubscription()
    // Si la suscripción existente fue creada sin la clave VAPID correcta, limpiarla
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
      body: JSON.stringify({ user_id: uid, rol: "gerencia", subscription: sub.toJSON() }),
    })
    if (!res.ok) {
      console.error("[v0] push/subscribe error:", await res.text())
    } else {
      console.log("[v0] push subscription guardada para uid:", uid)
    }
  }

  const requestPermission = async () => {
    if (!("Notification" in window)) return
    const result = await Notification.requestPermission()
    setNotifPermission(result)
    if (result === "granted" && userId) {
      await subscribeToPush(userId).catch(() => {})
    }
  }

  // Fecha formateada para el encabezado
  const [sy, sm, sd] = selectedDate.split("-").map(Number)
  const esHoy = selectedDate === hoy
  const fechaDisplay = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", weekday: "long", day: "numeric", month: "long",
  }).format(new Date(sy, sm - 1, sd))

  return (
    <div className="p-3 md:p-6 space-y-4">
      {/* Encabezado */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 max-w-2xl mx-auto">
        {/* Título */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-border overflow-hidden p-0.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base md:text-lg font-bold leading-tight">Reportes</h2>
            <p className="text-xs text-muted-foreground">Vista de gerencia</p>
          </div>
        </div>

        {/* Controles solo visibles en la pestaña de reportes */}
        {tab === "reportes" && (
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
        )}
      </div>

      {/* Pestañas */}
      <div className="flex gap-1 border-b max-w-2xl mx-auto">
        <button
          type="button"
          onClick={() => setTab("reportes")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "reportes"
              ? "border-brand text-brand"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <FileText className="h-4 w-4" />
          Reportes
          {tab === "reportes" && newCount > 0 && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
              {newCount > 9 ? "9+" : newCount}
            </span>
          )}
        </button>
      </div>

      {/* ── Pestaña: Reportes de secretarias ─────────────────────────────── */}
      {tab === "reportes" && (
        <div className="space-y-4 max-w-2xl mx-auto">
          {/* Banner in-app */}
          {banner && (
            <div className="flex items-center gap-3 rounded-lg border border-brand/30 bg-brand/10 px-4 py-2.5 text-sm">
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
          <p className="text-sm font-medium capitalize text-muted-foreground">
            {esHoy ? "Hoy · " : ""}{fechaDisplay}
          </p>

          {/* Lista */}
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
                        {grupo.reportes.map((inf) => (
                          <div key={inf.id} className="px-4 py-4 space-y-3">
                            <p className="font-semibold text-sm md:text-base leading-snug">{inf.nombre_reporte}</p>
                            {inf.notas && (
                              <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
                                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />
                                <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-snug">{inf.notas}</p>
                              </div>
                            )}
                            {inf.informe_imagenes.filter((a) => a.tipo !== "archivo").length > 0 && (
                              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {inf.informe_imagenes.filter((a) => a.tipo !== "archivo").map((img, imgIdx, imgArr) => (
                                  <button
                                    key={img.id}
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setLightbox({ urls: imgArr.map((a) => a.url_imagen), idx: imgIdx }) }}
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
                            <p className="text-xs text-muted-foreground/70">
                              {new Intl.DateTimeFormat("es-CO", {
                                timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: true,
                              }).format(new Date(inf.created_at))}
                              {inf.informe_imagenes.filter((a) => a.tipo !== "archivo").length > 0 && ` · ${inf.informe_imagenes.filter((a) => a.tipo !== "archivo").length} img`}
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
      )}


      {/* Lightbox */}
      <Dialog open={!!lightbox} onOpenChange={(open) => { if (!open) setLightbox(null) }}>
        <DialogContent className="max-w-[95vw] md:max-w-3xl p-2 bg-black/95 border-0">
          {lightbox && (
            <div className="relative flex items-center justify-center select-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={lightbox.urls[lightbox.idx]} alt="Imagen ampliada" className="w-full h-auto max-h-[85vh] object-contain rounded" />
              {lightbox.urls.length > 1 && (
                <>
                  <button type="button" onClick={() => setLightbox({ urls: lightbox.urls, idx: (lightbox.idx - 1 + lightbox.urls.length) % lightbox.urls.length })}
                    className="absolute left-1 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors">
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button type="button" onClick={() => setLightbox({ urls: lightbox.urls, idx: (lightbox.idx + 1) % lightbox.urls.length })}
                    className="absolute right-1 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors">
                    <ChevronRight className="h-5 w-5" />
                  </button>
                  <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
                    {lightbox.urls.map((_, i) => (
                      <button key={i} type="button" onClick={() => setLightbox({ urls: lightbox.urls, idx: i })}
                        className={`h-1.5 rounded-full transition-all ${i === lightbox.idx ? "w-4 bg-white" : "w-1.5 bg-white/40"}`} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
