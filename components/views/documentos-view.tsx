"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import {
  FolderOpen, Folder, Plus, ArrowLeft, Share2, LayoutGrid, List,
  Upload, Loader2, FileText, FileSpreadsheet, File as FileIcon,
  Trash2, X, Users,
} from "lucide-react"
import type { AuthenticatedUser } from "./login-view"

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Carpeta = {
  id: string
  nombre: string
  descripcion: string | null
  created_by: number
  created_by_nombre: string | null
  created_at: string
}

type Categoria = { id: number; nombre: string }

type Documento = {
  id: string
  carpeta_id: string
  categoria_id: number | null
  nombre_archivo: string
  url: string
  tipo_mime: string | null
  tamano_bytes: number | null
  notas: string | null
  uploaded_by: number
  uploaded_by_nombre: string | null
  created_at: string
}

type ContactUser = { id: number; nombre: string; rol: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIconMeta(mime: string | null, nombreArchivo: string): { Icon: typeof FileIcon; className: string } {
  const ext = nombreArchivo.split(".").pop()?.toLowerCase() ?? ""
  if (mime === "application/pdf" || ext === "pdf") return { Icon: FileText, className: "text-red-500" }
  if (["xls", "xlsx", "csv"].includes(ext)) return { Icon: FileSpreadsheet, className: "text-green-600" }
  if (["doc", "docx"].includes(ext)) return { Icon: FileText, className: "text-blue-600" }
  return { Icon: FileIcon, className: "text-muted-foreground" }
}

function initials(nombre: string): string {
  return nombre.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase()
}

// ─── Componente ───────────────────────────────────────────────────────────────

interface DocumentosViewProps {
  currentUser: AuthenticatedUser
}

export function DocumentosView({ currentUser }: DocumentosViewProps) {
  const { toast } = useToast()

  // Nivel 1: carpetas
  const [carpetas, setCarpetas] = useState<Carpeta[]>([])
  const [docCounts, setDocCounts] = useState<Map<string, number>>(new Map())
  const [loadingCarpetas, setLoadingCarpetas] = useState(true)
  const [showNewCarpeta, setShowNewCarpeta] = useState(false)
  const [newCarpetaNombre, setNewCarpetaNombre] = useState("")
  const [newCarpetaDescripcion, setNewCarpetaDescripcion] = useState("")
  const [creatingCarpeta, setCreatingCarpeta] = useState(false)

  // Nivel 2: dentro de una carpeta
  const [activeCarpetaId, setActiveCarpetaId] = useState<string | null>(null)
  const [documentos, setDocumentos] = useState<Documento[]>([])
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")

  // Categorías (catálogo global)
  const [categorias, setCategorias] = useState<Categoria[]>([])

  // Filtros
  const [filterCategoria, setFilterCategoria] = useState("all")
  const [filterUploader, setFilterUploader] = useState("all")
  const [filterDesde, setFilterDesde] = useState("")
  const [filterHasta, setFilterHasta] = useState("")

  // Subir documento
  const [showUpload, setShowUpload] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadCategoriaId, setUploadCategoriaId] = useState("")
  const [uploadNotas, setUploadNotas] = useState("")
  const [uploading, setUploading] = useState(false)
  const [showNewCategoria, setShowNewCategoria] = useState(false)
  const [newCategoriaNombre, setNewCategoriaNombre] = useState("")
  const [creatingCategoria, setCreatingCategoria] = useState(false)

  // Compartir carpeta
  const [showShare, setShowShare] = useState(false)
  const [contacts, setContacts] = useState<ContactUser[]>([])
  const [allowedIds, setAllowedIds] = useState<Set<number>>(new Set())
  const [loadingShare, setLoadingShare] = useState(false)
  const [savingShare, setSavingShare] = useState(false)

  const [deletingId, setDeletingId] = useState<string | null>(null)

  // ── Cargar carpetas ─────────────────────────────────────────────────────

  const loadCarpetas = useCallback(async () => {
    setLoadingCarpetas(true)
    try {
      const supabase = createClient()
      const { data: permisos } = await supabase
        .from("documento_carpeta_permisos")
        .select("carpeta_id")
        .eq("user_id", currentUser.id)
      const allowedCarpetaIds = ((permisos ?? []) as { carpeta_id: string }[]).map((p) => p.carpeta_id)

      let query = supabase.from("documento_carpetas").select("*").order("created_at", { ascending: false })
      query = allowedCarpetaIds.length > 0
        ? query.or(`created_by.eq.${currentUser.id},id.in.(${allowedCarpetaIds.join(",")})`)
        : query.eq("created_by", currentUser.id)

      const { data } = await query
      const rows = (data as Carpeta[]) ?? []
      setCarpetas(rows)

      if (rows.length > 0) {
        const { data: docsData } = await supabase
          .from("documentos")
          .select("carpeta_id")
          .in("carpeta_id", rows.map((c) => c.id))
        const counts = new Map<string, number>()
        for (const d of (docsData ?? []) as { carpeta_id: string }[]) {
          counts.set(d.carpeta_id, (counts.get(d.carpeta_id) ?? 0) + 1)
        }
        setDocCounts(counts)
      } else {
        setDocCounts(new Map())
      }
    } finally {
      setLoadingCarpetas(false)
    }
  }, [currentUser.id])

  useEffect(() => { loadCarpetas() }, [loadCarpetas])

  useEffect(() => {
    createClient()
      .from("documento_categorias")
      .select("id, nombre")
      .order("nombre")
      .then(({ data }: { data: Categoria[] | null }) => setCategorias(data ?? []))
  }, [])

  const handleCreateCarpeta = async () => {
    if (!newCarpetaNombre.trim()) return
    setCreatingCarpeta(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.from("documento_carpetas").insert({
        nombre: newCarpetaNombre.trim(),
        descripcion: newCarpetaDescripcion.trim() || null,
        created_by: currentUser.id,
        created_by_nombre: currentUser.nombre,
      })
      if (error) throw error
      setShowNewCarpeta(false)
      setNewCarpetaNombre("")
      setNewCarpetaDescripcion("")
      await loadCarpetas()
    } catch (err) {
      toast({ title: "Error", description: err instanceof Error ? err.message : "No se pudo crear la carpeta", variant: "destructive" })
    } finally {
      setCreatingCarpeta(false)
    }
  }

  // ── Cargar documentos de la carpeta activa ──────────────────────────────

  const loadDocumentos = useCallback(async (carpetaId: string) => {
    setLoadingDocs(true)
    try {
      const { data } = await createClient()
        .from("documentos")
        .select("*")
        .eq("carpeta_id", carpetaId)
        .order("created_at", { ascending: false })
      setDocumentos((data as Documento[]) ?? [])
    } finally {
      setLoadingDocs(false)
    }
  }, [])

  const selectCarpeta = (id: string) => {
    setActiveCarpetaId(id)
    setFilterCategoria("all")
    setFilterUploader("all")
    setFilterDesde("")
    setFilterHasta("")
    setViewMode("grid")
    loadDocumentos(id)
  }

  const activeCarpeta = carpetas.find((c) => c.id === activeCarpetaId)
  const esCreador = activeCarpeta?.created_by === currentUser.id

  // ── Subir documento ──────────────────────────────────────────────────────

  const handleCreateCategoria = async () => {
    if (!newCategoriaNombre.trim()) return
    setCreatingCategoria(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("documento_categorias")
        .insert({ nombre: newCategoriaNombre.trim(), created_by: currentUser.id })
        .select("id, nombre")
        .single()
      if (error) throw error
      const nueva = data as Categoria
      setCategorias((prev) => [...prev, nueva].sort((a, b) => a.nombre.localeCompare(b.nombre)))
      setUploadCategoriaId(String(nueva.id))
      setNewCategoriaNombre("")
      setShowNewCategoria(false)
    } catch (err) {
      toast({ title: "Error", description: "No se pudo crear la categoría (¿ya existe?)", variant: "destructive" })
    } finally {
      setCreatingCategoria(false)
    }
  }

  const handleUpload = async () => {
    if (!uploadFile || !activeCarpetaId) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", uploadFile)
      fd.append("folder", `documentos/${activeCarpetaId}`)
      const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
      const json = await res.json()
      if (!json.success) throw new Error(json.error ?? "Error al subir el archivo")

      const { error } = await createClient().from("documentos").insert({
        carpeta_id: activeCarpetaId,
        categoria_id: uploadCategoriaId ? Number(uploadCategoriaId) : null,
        nombre_archivo: uploadFile.name,
        url: json.url,
        tipo_mime: uploadFile.type || null,
        tamano_bytes: uploadFile.size,
        notas: uploadNotas.trim() || null,
        uploaded_by: currentUser.id,
        uploaded_by_nombre: currentUser.nombre,
      })
      if (error) throw error

      toast({ title: "Documento subido" })
      setShowUpload(false)
      setUploadFile(null)
      setUploadCategoriaId("")
      setUploadNotas("")
      await loadDocumentos(activeCarpetaId)
      await loadCarpetas()
    } catch (err) {
      toast({ title: "Error", description: err instanceof Error ? err.message : "No se pudo subir el documento", variant: "destructive" })
    } finally {
      setUploading(false)
    }
  }

  const handleDeleteDocumento = async (doc: Documento) => {
    setDeletingId(doc.id)
    try {
      const { error } = await createClient().from("documentos").delete().eq("id", doc.id)
      if (error) throw error
      setDocumentos((prev) => prev.filter((d) => d.id !== doc.id))
      setDocCounts((prev) => {
        const next = new Map(prev)
        next.set(doc.carpeta_id, Math.max(0, (next.get(doc.carpeta_id) ?? 1) - 1))
        return next
      })
    } catch {
      toast({ title: "Error", description: "No se pudo eliminar el documento", variant: "destructive" })
    } finally {
      setDeletingId(null)
    }
  }

  // ── Compartir carpeta ────────────────────────────────────────────────────

  const openShare = async () => {
    if (!activeCarpetaId) return
    setShowShare(true)
    setLoadingShare(true)
    try {
      const supabase = createClient()
      const [{ data: usersData }, { data: permisosData }] = await Promise.all([
        supabase.from("usuarios").select("id, nombre, rol").eq("activo", true).neq("id", currentUser.id).order("nombre"),
        supabase.from("documento_carpeta_permisos").select("user_id").eq("carpeta_id", activeCarpetaId),
      ])
      setContacts((usersData ?? []) as ContactUser[])
      setAllowedIds(new Set(((permisosData ?? []) as { user_id: number }[]).map((p) => p.user_id)))
    } finally {
      setLoadingShare(false)
    }
  }

  const toggleAllowed = (uid: number) => {
    setAllowedIds((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }

  const handleSaveShare = async () => {
    if (!activeCarpetaId) return
    setSavingShare(true)
    try {
      const supabase = createClient()
      await supabase.from("documento_carpeta_permisos").delete().eq("carpeta_id", activeCarpetaId)
      if (allowedIds.size > 0) {
        await supabase.from("documento_carpeta_permisos").insert(
          [...allowedIds].map((uid) => ({ carpeta_id: activeCarpetaId, user_id: uid }))
        )
      }
      toast({ title: "Carpeta compartida actualizada" })
      setShowShare(false)
    } catch {
      toast({ title: "Error", description: "No se pudo guardar", variant: "destructive" })
    } finally {
      setSavingShare(false)
    }
  }

  // ── Filtros ──────────────────────────────────────────────────────────────

  const uploaders = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of documentos) {
      if (!map.has(d.uploaded_by)) map.set(d.uploaded_by, d.uploaded_by_nombre ?? `Usuario ${d.uploaded_by}`)
    }
    return [...map.entries()].map(([id, nombre]) => ({ id, nombre }))
  }, [documentos])

  const filteredDocs = useMemo(() => {
    return documentos.filter((d) => {
      if (filterCategoria !== "all" && String(d.categoria_id ?? "") !== filterCategoria) return false
      if (filterUploader !== "all" && String(d.uploaded_by) !== filterUploader) return false
      const fecha = d.created_at.slice(0, 10)
      if (filterDesde && fecha < filterDesde) return false
      if (filterHasta && fecha > filterHasta) return false
      return true
    })
  }, [documentos, filterCategoria, filterUploader, filterDesde, filterHasta])

  const categoriaNombre = (id: number | null) => categorias.find((c) => c.id === id)?.nombre ?? null

  // ── Render ────────────────────────────────────────────────────────────────

  if (!activeCarpetaId) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-border overflow-hidden p-0.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
            </div>
            <div>
              <h2 className="text-base md:text-lg font-bold leading-tight">Documentos</h2>
              <p className="text-[11px] text-muted-foreground">Carpetas y archivos compartidos</p>
            </div>
          </div>
          <Button size="sm" onClick={() => setShowNewCarpeta(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            Nueva carpeta
          </Button>
        </div>

        {loadingCarpetas ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : carpetas.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
            <FolderOpen className="h-10 w-10 opacity-30" />
            <p className="text-sm">Aún no tienes carpetas</p>
            <Button size="sm" variant="outline" className="gap-1.5 mt-1" onClick={() => setShowNewCarpeta(true)}>
              <Plus className="h-3.5 w-3.5" />
              Crear la primera
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {carpetas.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => selectCarpeta(c.id)}
                className="flex flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left hover:border-brand hover:bg-brand/5 transition-colors"
              >
                <Folder className="h-8 w-8 text-brand" />
                <div className="min-w-0 w-full">
                  <p className="text-sm font-semibold truncate">{c.nombre}</p>
                  {c.descripcion && <p className="text-[11px] text-muted-foreground truncate">{c.descripcion}</p>}
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {docCounts.get(c.id) ?? 0} archivo{(docCounts.get(c.id) ?? 0) !== 1 ? "s" : ""} · {c.created_by_nombre ?? "—"}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Dialog nueva carpeta */}
        <Dialog open={showNewCarpeta} onOpenChange={setShowNewCarpeta}>
          <DialogContent className="max-w-sm rounded-2xl">
            <DialogHeader>
              <DialogTitle>Nueva carpeta</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Nombre</Label>
                <Input value={newCarpetaNombre} onChange={(e) => setNewCarpetaNombre(e.target.value)} placeholder="Ej: Legal, RRHH..." className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Descripción (opcional)</Label>
                <Textarea value={newCarpetaDescripcion} onChange={(e) => setNewCarpetaDescripcion(e.target.value)} className="text-sm" rows={2} />
              </div>
              <Button className="w-full" size="sm" onClick={handleCreateCarpeta} disabled={creatingCarpeta || !newCarpetaNombre.trim()}>
                {creatingCarpeta ? <Loader2 className="h-4 w-4 animate-spin" /> : "Crear carpeta"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => setActiveCarpetaId(null)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="text-sm md:text-lg font-bold truncate">{activeCarpeta?.nombre}</h2>
            <p className="text-[11px] text-muted-foreground truncate">{activeCarpeta?.descripcion}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {esCreador && (
            <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs" onClick={openShare}>
              <Share2 className="h-3.5 w-3.5" />
              Compartir
            </Button>
          )}
          <Button size="sm" className="gap-1.5 h-8 text-xs" onClick={() => setShowUpload(true)}>
            <Upload className="h-3.5 w-3.5" />
            Subir documento
          </Button>
        </div>
      </div>

      {/* Toolbar: filtros + toggle de vista */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={filterCategoria} onValueChange={setFilterCategoria}>
          <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Categoría" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las categorías</SelectItem>
            {categorias.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>{c.nombre}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterUploader} onValueChange={setFilterUploader}>
          <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Subido por" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {uploaders.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>{u.nombre}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" value={filterDesde} onChange={(e) => setFilterDesde(e.target.value)} className="h-8 w-32 text-xs" title="Desde" />
        <Input type="date" value={filterHasta} onChange={(e) => setFilterHasta(e.target.value)} className="h-8 w-32 text-xs" title="Hasta" />

        <div className="ml-auto flex items-center gap-1 rounded-lg border p-0.5">
          <Button size="icon" variant={viewMode === "grid" ? "default" : "ghost"} className="h-7 w-7" onClick={() => setViewMode("grid")}>
            <LayoutGrid className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant={viewMode === "list" ? "default" : "ghost"} className="h-7 w-7" onClick={() => setViewMode("list")}>
            <List className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Documentos */}
      {loadingDocs ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : filteredDocs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
          <FileIcon className="h-10 w-10 opacity-30" />
          <p className="text-sm">{documentos.length === 0 ? "Sin documentos aún" : "Ningún documento coincide con los filtros"}</p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filteredDocs.map((doc) => {
            const puedeEliminar = doc.uploaded_by === currentUser.id || esCreador
            const { Icon, className } = getFileIconMeta(doc.tipo_mime, doc.nombre_archivo)
            const cat = categoriaNombre(doc.categoria_id)
            return (
              <div key={doc.id} className="group relative flex flex-col gap-1.5 rounded-xl border bg-card p-2.5">
                <a href={doc.url} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-1.5">
                  {doc.tipo_mime?.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={doc.url} alt={doc.nombre_archivo} className="h-16 w-full object-cover rounded-lg" />
                  ) : (
                    <div className="flex h-16 w-full items-center justify-center rounded-lg bg-muted">
                      <Icon className={`h-8 w-8 ${className}`} />
                    </div>
                  )}
                  <p className="text-[11px] font-medium text-center truncate w-full" title={doc.nombre_archivo}>{doc.nombre_archivo}</p>
                </a>
                {cat && <Badge variant="outline" className="text-[9px] px-1.5 py-0 self-center">{cat}</Badge>}
                <p className="text-[9px] text-muted-foreground text-center truncate">{doc.uploaded_by_nombre} · {formatFecha(doc.created_at)}</p>
                {puedeEliminar && (
                  <button
                    type="button"
                    onClick={() => handleDeleteDocumento(doc)}
                    disabled={deletingId === doc.id}
                    className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive"
                  >
                    {deletingId === doc.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="divide-y divide-border rounded-xl border bg-card overflow-hidden">
          {filteredDocs.map((doc) => {
            const puedeEliminar = doc.uploaded_by === currentUser.id || esCreador
            const { Icon, className } = getFileIconMeta(doc.tipo_mime, doc.nombre_archivo)
            const cat = categoriaNombre(doc.categoria_id)
            return (
              <div key={doc.id} className="flex items-center gap-3 px-3 py-2.5">
                <a href={doc.url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                  {doc.tipo_mime?.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={doc.url} alt={doc.nombre_archivo} className="h-9 w-9 object-cover rounded-md" />
                  ) : (
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                      <Icon className={`h-4 w-4 ${className}`} />
                    </div>
                  )}
                </a>
                <a href={doc.url} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{doc.nombre_archivo}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {doc.uploaded_by_nombre} · {formatFecha(doc.created_at)} · {formatBytes(doc.tamano_bytes)}
                    {doc.notas ? ` · ${doc.notas}` : ""}
                  </p>
                </a>
                {cat && <Badge variant="outline" className="text-[10px] shrink-0">{cat}</Badge>}
                {puedeEliminar && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDeleteDocumento(doc)}
                    disabled={deletingId === doc.id}
                  >
                    {deletingId === doc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Dialog subir documento */}
      <Dialog open={showUpload} onOpenChange={(open) => { setShowUpload(open); if (!open) { setUploadFile(null); setShowNewCategoria(false) } }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Subir documento</DialogTitle>
            <DialogDescription>Cualquier tipo de archivo, máximo 25MB.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Archivo</Label>
              <Input type="file" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} className="text-sm" />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Categoría (opcional)</Label>
              {!showNewCategoria ? (
                <Select
                  value={uploadCategoriaId}
                  onValueChange={(v) => (v === "__new__" ? setShowNewCategoria(true) : setUploadCategoriaId(v))}
                >
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Sin categoría" /></SelectTrigger>
                  <SelectContent>
                    {categorias.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.nombre}</SelectItem>
                    ))}
                    <SelectItem value="__new__">+ Nueva categoría</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex gap-2">
                  <Input
                    value={newCategoriaNombre}
                    onChange={(e) => setNewCategoriaNombre(e.target.value)}
                    placeholder="Nombre de la categoría"
                    className="h-9 text-sm flex-1"
                  />
                  <Button size="sm" className="h-9" onClick={handleCreateCategoria} disabled={creatingCategoria || !newCategoriaNombre.trim()}>
                    {creatingCategoria ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Crear"}
                  </Button>
                  <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0" onClick={() => setShowNewCategoria(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Notas (opcional)</Label>
              <Textarea value={uploadNotas} onChange={(e) => setUploadNotas(e.target.value)} className="text-sm" rows={2} />
            </div>

            <Button className="w-full" size="sm" onClick={handleUpload} disabled={uploading || !uploadFile}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Subir"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog compartir carpeta */}
      <Dialog open={showShare} onOpenChange={setShowShare}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Compartir carpeta</DialogTitle>
            <DialogDescription>Elige quién más puede ver "{activeCarpeta?.nombre}".</DialogDescription>
          </DialogHeader>
          {loadingShare ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <>
              <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
                {contacts.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => toggleAllowed(c.id)}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 cursor-pointer hover:bg-muted/40 select-none"
                  >
                    <Checkbox checked={allowedIds.has(c.id)} className="h-4 w-4 pointer-events-none" />
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand text-[10px] font-bold">
                      {initials(c.nombre)}
                    </div>
                    <span className="text-sm">{c.nombre}</span>
                  </div>
                ))}
                {contacts.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4 flex items-center justify-center gap-1.5">
                    <Users className="h-3.5 w-3.5" /> No hay más usuarios
                  </p>
                )}
              </div>
              <Button className="w-full" size="sm" onClick={handleSaveShare} disabled={savingShare}>
                {savingShare ? <Loader2 className="h-4 w-4 animate-spin" /> : `Guardar (${allowedIds.size} compartido${allowedIds.size !== 1 ? "s" : ""})`}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
