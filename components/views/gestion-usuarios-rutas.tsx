"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2, Plus, Pencil, Trash2, Users, Route as RouteIcon, Link2, Eye, EyeOff, MapPin, Globe2, CheckCircle2, Shield, Smartphone, RotateCcw, Save, Info, MessageSquare } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { ALL_MODULES, MODULE_GROUPS, getDefaultModulesForRole, isDefaultMobileNav } from "@/lib/modules-catalog"
import type { ModuleDefinition } from "@/lib/modules-catalog"

// ─── Tipos ───────────────────────────────────────────────────────────────────

type Usuario = {
  id: number
  usuario: string
  nombre: string
  rol: string
  activo: boolean
  acceso_modulo_reporte: boolean | null
}

type Ruta = {
  id: number
  nombre: string
  ciudad: string | null
  pais: string | null
}

const ROLES = ["vendedor", "secretaria", "gerencia", "admin", "liquidador", "socioadmin"] as const

const ROL_LABELS: Record<string, string> = {
  vendedor:   "Vendedor",
  admin:      "Administrador",
  secretaria: "Secretaria",
  gerencia:   "Gerencia",
  liquidador: "Liquidador",
  socioadmin: "Socio Admin",
}

const ROL_BADGE: Record<string, string> = {
  vendedor:   "bg-blue-100   text-blue-800   dark:bg-blue-900/40   dark:text-blue-300",
  admin:      "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  secretaria: "bg-green-100  text-green-800  dark:bg-green-900/40  dark:text-green-300",
  gerencia:   "bg-amber-100  text-amber-800  dark:bg-amber-900/40  dark:text-amber-300",
  liquidador: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  socioadmin: "bg-teal-100   text-teal-800   dark:bg-teal-900/40   dark:text-teal-300",
}

// ─── Tab Usuarios ─────────────────────────────────────────────────────────────

function UsuariosTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Usuario | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [showPass, setShowPass] = useState(false)

  const [fNombre, setFNombre] = useState("")
  const [fUsuario, setFUsuario] = useState("")
  const [fPassword, setFPassword] = useState("")
  const [fRol, setFRol] = useState<string>("vendedor")
  const [fActivo, setFActivo] = useState(true)
  const [fAccesoReporte, setFAccesoReporte] = useState(false)

  const fetchUsuarios = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("usuarios")
        .select("id, usuario, nombre, rol, activo, acceso_modulo_reporte")
        .order("nombre", { ascending: true })
      if (error) throw error
      setUsuarios(data ?? [])
    } catch (err) {
      console.error("[v0] Error fetching usuarios:", err)
      toast({ title: "Error", description: "No se pudieron cargar los usuarios", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { fetchUsuarios() }, [fetchUsuarios])

  const openCreate = () => {
    setEditing(null)
    setFNombre(""); setFUsuario(""); setFPassword(""); setFRol("vendedor")
    setFActivo(true); setFAccesoReporte(false); setShowPass(false)
    setShowForm(true)
  }

  const openEdit = (u: Usuario) => {
    setEditing(u)
    setFNombre(u.nombre); setFUsuario(u.usuario); setFPassword("")
    setFRol(u.rol); setFActivo(u.activo)
    setFAccesoReporte(u.acceso_modulo_reporte ?? false)
    setShowPass(false); setShowForm(true)
  }

  const handleSave = async () => {
    if (!fNombre.trim() || !fUsuario.trim()) {
      toast({ title: "Campos requeridos", description: "Nombre y usuario son obligatorios", variant: "destructive" })
      return
    }
    if (!editing && !fPassword.trim()) {
      toast({ title: "Contraseña requerida", description: "Ingresa una contraseña para el nuevo usuario", variant: "destructive" })
      return
    }
    setSaving(true)
    try {
      const supabase = createClient()
      if (editing) {
        const payload: Record<string, unknown> = {
          nombre: fNombre.trim(), usuario: fUsuario.trim(),
          rol: fRol, activo: fActivo, acceso_modulo_reporte: fAccesoReporte,
        }
        if (fPassword.trim()) payload.password = fPassword.trim()
        const { error } = await supabase.from("usuarios").update(payload).eq("id", editing.id)
        if (error) throw error
        toast({ title: "Usuario actualizado" })
      } else {
        const { error } = await supabase.from("usuarios").insert({
          nombre: fNombre.trim(), usuario: fUsuario.trim(),
          password: fPassword.trim(), rol: fRol,
          activo: fActivo, acceso_modulo_reporte: fAccesoReporte,
        })
        if (error) throw error
        toast({ title: "Usuario creado" })
      }
      setShowForm(false)
      fetchUsuarios()
    } catch (err: any) {
      const msg: string = err?.message ?? "Error desconocido"
      console.error("[v0] Error saving usuario:", msg)
      toast({
        title: "Error",
        description: msg.toLowerCase().includes("unique") ? "El nombre de usuario ya existe" : msg,
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (confirmDeleteId === null) return
    try {
      const supabase = createClient()
      const { error } = await supabase.from("usuarios").delete().eq("id", confirmDeleteId)
      if (error) throw error
      toast({ title: "Usuario eliminado" })
      setConfirmDeleteId(null)
      fetchUsuarios()
    } catch (err: any) {
      console.error("[v0] Error deleting usuario:", err)
      toast({ title: "Error", description: "No se pudo eliminar el usuario", variant: "destructive" })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {loading ? "Cargando..." : `${usuarios.length} usuario${usuarios.length !== 1 ? "s" : ""} registrados`}
        </p>
        <Button size="sm" onClick={openCreate} className="gap-1.5 h-8 text-xs">
          <Plus className="h-3.5 w-3.5" /> Nuevo usuario
        </Button>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Nombre</th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">Usuario</th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Rol</th>
                <th className="px-3 py-2 text-center text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden md:table-cell">Activo</th>
                <th className="px-3 py-2 text-center text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden lg:table-cell">Reportes</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {usuarios.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    No hay usuarios registrados
                  </td>
                </tr>
              )}
              {usuarios.map((u) => (
                <tr key={u.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5 font-medium text-sm">{u.nombre}</td>
                  <td className="px-3 py-2.5 text-muted-foreground font-mono text-xs hidden sm:table-cell">{u.usuario}</td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${ROL_BADGE[u.rol] ?? "bg-muted text-muted-foreground"}`}>
                      {ROL_LABELS[u.rol] ?? u.rol}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center hidden md:table-cell">
                    <span className={`inline-block h-2 w-2 rounded-full ${u.activo ? "bg-green-500" : "bg-red-400"}`} title={u.activo ? "Activo" : "Inactivo"} />
                  </td>
                  <td className="px-3 py-2.5 text-center hidden lg:table-cell">
                    <span className={`inline-block h-2 w-2 rounded-full ${u.acceso_modulo_reporte ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} title={u.acceso_modulo_reporte ? "Con acceso" : "Sin acceso"} />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Editar" onClick={() => openEdit(u)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" title="Eliminar" onClick={() => setConfirmDeleteId(u.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Formulario crear / editar */}
      <Dialog open={showForm} onOpenChange={(o) => !saving && setShowForm(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar usuario" : "Nuevo usuario"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label className="text-xs">Nombre completo</Label>
              <Input value={fNombre} onChange={(e) => setFNombre(e.target.value)} placeholder="Juan Pérez" className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Nombre de usuario</Label>
              <Input value={fUsuario} onChange={(e) => setFUsuario(e.target.value)} placeholder="jperez" autoComplete="off" className="h-9 text-sm font-mono" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{editing ? "Nueva contraseña (vacío = no cambiar)" : "Contraseña"}</Label>
              <div className="relative">
                <Input
                  type={showPass ? "text" : "password"}
                  value={fPassword}
                  onChange={(e) => setFPassword(e.target.value)}
                  placeholder={editing ? "••••••••" : "Mínimo 4 caracteres"}
                  autoComplete="new-password"
                  className="h-9 text-sm pr-9"
                />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Rol</Label>
              <Select value={fRol} onValueChange={setFRol}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r} className="text-sm">{ROL_LABELS[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={fActivo} onCheckedChange={(v) => setFActivo(v === true)} className="h-4 w-4" />
                <span className="text-sm">Usuario activo</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={fAccesoReporte} onCheckedChange={(v) => setFAccesoReporte(v === true)} className="h-4 w-4" />
                <span className="text-sm">Acceso a Reportes</span>
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setShowForm(false)} disabled={saving}>Cancelar</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {editing ? "Guardar cambios" : "Crear usuario"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmar eliminación */}
      <Dialog open={confirmDeleteId !== null} onOpenChange={(o) => !o && setConfirmDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Eliminar usuario</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-1">
            ¿Confirmas la eliminación? También se eliminarán sus asignaciones de rutas.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancelar</Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>Eliminar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Tab Rutas ────────────────────────────────────────────────────────────────

function RutasTab() {
  const { toast } = useToast()
  const [rutas, setRutas] = useState<Ruta[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Ruta | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const [fNombre, setFNombre] = useState("")
  const [fCiudad, setFCiudad] = useState("")
  const [fPais, setFPais] = useState("")

  const fetchRutas = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("rutas")
        .select("id, nombre, ciudad, pais")
        .order("id", { ascending: true })
      if (error) throw error
      setRutas(data ?? [])
    } catch (err) {
      console.error("[v0] Error fetching rutas:", err)
      toast({ title: "Error", description: "No se pudieron cargar las rutas", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { fetchRutas() }, [fetchRutas])

  const openCreate = () => {
    setEditing(null); setFNombre(""); setFCiudad(""); setFPais("")
    setShowForm(true)
  }

  const openEdit = (r: Ruta) => {
    setEditing(r); setFNombre(r.nombre); setFCiudad(r.ciudad ?? ""); setFPais(r.pais ?? "")
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!fNombre.trim()) {
      toast({ title: "Campo requerido", description: "El nombre de la ruta es obligatorio", variant: "destructive" })
      return
    }
    setSaving(true)
    try {
      const supabase = createClient()
      const payload = {
        nombre: fNombre.trim(),
        ciudad: fCiudad.trim() || null,
        pais: fPais.trim() || null,
      }
      if (editing) {
        const { error } = await supabase.from("rutas").update(payload).eq("id", editing.id)
        if (error) throw error
        toast({ title: "Ruta actualizada" })
      } else {
        const { error } = await supabase.from("rutas").insert(payload)
        if (error) throw error
        toast({ title: "Ruta creada" })
      }
      setShowForm(false)
      fetchRutas()
    } catch (err: any) {
      console.error("[v0] Error saving ruta:", err)
      toast({ title: "Error", description: err?.message ?? "Error desconocido", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (confirmDeleteId === null) return
    try {
      const supabase = createClient()
      const { error } = await supabase.from("rutas").delete().eq("id", confirmDeleteId)
      if (error) throw error
      toast({ title: "Ruta eliminada" })
      setConfirmDeleteId(null)
      fetchRutas()
    } catch (err: any) {
      console.error("[v0] Error deleting ruta:", err)
      toast({ title: "Error", description: "No se pudo eliminar la ruta", variant: "destructive" })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {loading ? "Cargando..." : `${rutas.length} ruta${rutas.length !== 1 ? "s" : ""} registradas`}
        </p>
        <Button size="sm" onClick={openCreate} className="gap-1.5 h-8 text-xs">
          <Plus className="h-3.5 w-3.5" /> Nueva ruta
        </Button>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {rutas.length === 0 && (
            <div className="col-span-full py-10 text-center text-sm text-muted-foreground">
              No hay rutas registradas
            </div>
          )}
          {rutas.map((r) => (
            <div key={r.id} className="group relative rounded-xl border border-border bg-card p-4 hover:border-brand/40 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                    <RouteIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm leading-tight truncate">{r.nombre}</p>
                    <p className="text-[10px] font-bold text-muted-foreground">Ruta #{r.id}</p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="icon" className="h-7 w-7" title="Editar" onClick={() => openEdit(r)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" title="Eliminar" onClick={() => setConfirmDeleteId(r.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {(r.ciudad || r.pais) && (
                <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {r.ciudad && (
                    <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{r.ciudad}</span>
                  )}
                  {r.pais && (
                    <span className="flex items-center gap-1"><Globe2 className="h-3 w-3" />{r.pais}</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Formulario */}
      <Dialog open={showForm} onOpenChange={(o) => !saving && setShowForm(o)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{editing ? "Editar ruta" : "Nueva ruta"}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label className="text-xs">Nombre de la ruta <span className="text-destructive">*</span></Label>
              <Input value={fNombre} onChange={(e) => setFNombre(e.target.value)} placeholder="Ruta Norte" className="h-9 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Ciudad</Label>
                <Input value={fCiudad} onChange={(e) => setFCiudad(e.target.value)} placeholder="Bogotá" className="h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">País</Label>
                <Input value={fPais} onChange={(e) => setFPais(e.target.value)} placeholder="Colombia" className="h-9 text-sm" />
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setShowForm(false)} disabled={saving}>Cancelar</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {editing ? "Guardar cambios" : "Crear ruta"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmar eliminación */}
      <Dialog open={confirmDeleteId !== null} onOpenChange={(o) => !o && setConfirmDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Eliminar ruta</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-1">
            ¿Confirmas la eliminación? También se eliminarán las asignaciones de usuarios a esta ruta.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancelar</Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>Eliminar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Tab Asignaciones ─────────────────────────────────────────────────────────

function AsignacionesTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [rutas, setRutas] = useState<Ruta[]>([])
  const [asignaciones, setAsignaciones] = useState<{ usuario_id: number; ruta_id: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [checkedRutas, setCheckedRutas] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const [uRes, rRes, aRes] = await Promise.all([
        supabase.from("usuarios").select("id, usuario, nombre, rol, activo, acceso_modulo_reporte").order("nombre"),
        supabase.from("rutas").select("id, nombre, ciudad, pais").order("id"),
        supabase.from("usuario_rutas").select("usuario_id, ruta_id"),
      ])
      if (uRes.error) throw uRes.error
      if (rRes.error) throw rRes.error
      if (aRes.error) throw aRes.error
      setUsuarios(uRes.data ?? [])
      setRutas(rRes.data ?? [])
      setAsignaciones(aRes.data ?? [])
    } catch (err) {
      console.error("[v0] Error fetching asignaciones:", err)
      toast({ title: "Error", description: "No se pudieron cargar los datos", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Cuando cambia el usuario seleccionado, cargar sus rutas actuales
  useEffect(() => {
    if (selectedUserId === null) { setCheckedRutas(new Set()); setDirty(false); return }
    const assigned = asignaciones
      .filter((a) => a.usuario_id === selectedUserId)
      .map((a) => a.ruta_id)
    setCheckedRutas(new Set(assigned))
    setDirty(false)
  }, [selectedUserId, asignaciones])

  const toggleRuta = (rutaId: number) => {
    setCheckedRutas((prev) => {
      const next = new Set(prev)
      if (next.has(rutaId)) next.delete(rutaId)
      else next.add(rutaId)
      return next
    })
    setDirty(true)
  }

  const handleGuardar = async () => {
    if (selectedUserId === null) return
    setSaving(true)
    try {
      const supabase = createClient()
      const anteriores = new Set(
        asignaciones.filter((a) => a.usuario_id === selectedUserId).map((a) => a.ruta_id)
      )
      const agregar = [...checkedRutas].filter((id) => !anteriores.has(id))
      const quitar = [...anteriores].filter((id) => !checkedRutas.has(id))

      if (quitar.length > 0) {
        const { error } = await supabase
          .from("usuario_rutas")
          .delete()
          .eq("usuario_id", selectedUserId)
          .in("ruta_id", quitar)
        if (error) throw error
      }
      if (agregar.length > 0) {
        const { error } = await supabase
          .from("usuario_rutas")
          .insert(agregar.map((ruta_id) => ({ usuario_id: selectedUserId, ruta_id })))
        if (error) throw error
      }

      // Actualizar estado local para reflejar cambios sin re-fetch completo
      setAsignaciones((prev) => {
        const sinEste = prev.filter((a) => a.usuario_id !== selectedUserId)
        const nuevas = [...checkedRutas].map((ruta_id) => ({ usuario_id: selectedUserId, ruta_id }))
        return [...sinEste, ...nuevas]
      })
      setDirty(false)
      toast({ title: "Asignaciones guardadas" })
    } catch (err: any) {
      console.error("[v0] Error saving asignaciones:", err)
      toast({ title: "Error", description: err?.message ?? "Error al guardar", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const usuarioSeleccionado = usuarios.find((u) => u.id === selectedUserId)
  const totalAsignadas = selectedUserId
    ? asignaciones.filter((a) => a.usuario_id === selectedUserId).length
    : null

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      {/* Panel izquierdo: lista de usuarios */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-2">
          Seleccionar usuario
        </p>
        <div className="rounded-xl border border-border overflow-hidden max-h-[420px] overflow-y-auto">
          {usuarios.map((u) => {
            const isSelected = u.id === selectedUserId
            const rutasCount = asignaciones.filter((a) => a.usuario_id === u.id).length
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => setSelectedUserId(u.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-b border-border last:border-0 transition-colors ${
                  isSelected ? "bg-brand/10 text-brand" : "hover:bg-muted/40"
                }`}
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-bold">
                  {u.nombre.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium truncate leading-tight ${isSelected ? "text-brand" : ""}`}>{u.nombre}</p>
                  <p className="text-[10px] text-muted-foreground">{ROL_LABELS[u.rol] ?? u.rol} · {rutasCount} ruta{rutasCount !== 1 ? "s" : ""}</p>
                </div>
                {isSelected && <CheckCircle2 className="h-4 w-4 shrink-0 text-brand" />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Panel derecho: rutas del usuario */}
      <div className="space-y-3">
        {selectedUserId === null ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground">
            <Link2 className="h-8 w-8 opacity-30" />
            <p className="text-sm">Selecciona un usuario para gestionar sus rutas</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-sm">{usuarioSeleccionado?.nombre}</p>
                <p className="text-xs text-muted-foreground">
                  {checkedRutas.size} ruta{checkedRutas.size !== 1 ? "s" : ""} asignada{checkedRutas.size !== 1 ? "s" : ""}
                  {totalAsignadas !== null && totalAsignadas !== checkedRutas.size && (
                    <span className="ml-1 text-amber-600 dark:text-amber-400">(sin guardar)</span>
                  )}
                </p>
              </div>
              <Button
                size="sm"
                onClick={handleGuardar}
                disabled={saving || !dirty}
                className="gap-1.5 h-8 text-xs"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                Guardar
              </Button>
            </div>

            {rutas.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay rutas registradas</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {rutas.map((r) => {
                  const checked = checkedRutas.has(r.id)
                  return (
                    <label
                      key={r.id}
                      className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        checked
                          ? "border-brand/50 bg-brand/5 dark:bg-brand/10"
                          : "border-border hover:border-border/80 hover:bg-muted/20"
                      }`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleRuta(r.id)}
                        className="h-4 w-4"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{r.nombre}</p>
                        <p className="text-[10px] text-muted-foreground">
                          #{r.id}{r.ciudad ? ` · ${r.ciudad}` : ""}{r.pais ? ` · ${r.pais}` : ""}
                        </p>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Tab Permisos ─────────────────────────────────────────────────────────────

type PermRow = {
  viewId: string
  label: string
  description: string
  group: string
  enabled: boolean
  inMobileNav: boolean
}

function buildDefaultRows(rol: string): PermRow[] {
  const defaultViewIds = new Set(getDefaultModulesForRole(rol).map((m) => m.viewId))
  return ALL_MODULES.map((m) => {
    const inDefault = defaultViewIds.has(m.viewId)
    return {
      viewId: m.viewId,
      label: m.label,
      description: m.description,
      group: m.group,
      enabled: inDefault,
      inMobileNav: inDefault && isDefaultMobileNav(m, rol),
    }
  })
}

function PermisosTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [permRows, setPermRows] = useState<PermRow[]>([])
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [dirty, setDirty] = useState(false)

  const fetchUsuarios = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("usuarios")
        .select("id, usuario, nombre, rol, activo, acceso_modulo_reporte")
        .order("nombre")
      if (error) throw error
      setUsuarios(data ?? [])
    } catch (err) {
      console.error("[v0] Error fetching usuarios (permisos):", err)
      toast({ title: "Error", description: "No se pudieron cargar los usuarios", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { fetchUsuarios() }, [fetchUsuarios])

  const loadPermissions = useCallback(async (userId: number, rol: string) => {
    const defaults = buildDefaultRows(rol)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("user_permissions")
        .select("view_id, enabled, in_mobile_nav")
        .eq("user_id", userId)
      if (error) throw error

      if (!data || data.length === 0) {
        setPermRows(defaults)
        return
      }

      const dbMap: Record<string, { enabled: boolean; inMobileNav: boolean }> = {}
      data.forEach((row: { view_id: string; enabled: boolean; in_mobile_nav: boolean }) => { dbMap[row.view_id] = { enabled: row.enabled, inMobileNav: row.in_mobile_nav } })

      setPermRows(defaults.map((r) =>
        dbMap[r.viewId] !== undefined
          ? { ...r, enabled: dbMap[r.viewId].enabled, inMobileNav: dbMap[r.viewId].inMobileNav }
          : r,
      ))
    } catch (err) {
      console.error("[v0] Error loading permissions:", err)
      setPermRows(defaults)
    }
  }, [])

  const handleSelectUser = (userId: number) => {
    const u = usuarios.find((u) => u.id === userId)
    if (!u) return
    setSelectedUserId(userId)
    setDirty(false)
    loadPermissions(userId, u.rol)
  }

  const toggleEnabled = (viewId: string) => {
    setPermRows((prev) =>
      prev.map((r) =>
        r.viewId === viewId
          ? { ...r, enabled: !r.enabled, inMobileNav: r.enabled ? false : r.inMobileNav }
          : r,
      ),
    )
    setDirty(true)
  }

  const toggleMobileNav = (viewId: string) => {
    setPermRows((prev) =>
      prev.map((r) => (r.viewId === viewId ? { ...r, inMobileNav: !r.inMobileNav } : r)),
    )
    setDirty(true)
  }

  const mobileCount = permRows.filter((r) => r.enabled && r.inMobileNav).length

  const handleGuardar = async () => {
    if (selectedUserId === null) return
    setSaving(true)
    try {
      const supabase = createClient()
      await supabase.from("user_permissions").delete().eq("user_id", selectedUserId)
      if (permRows.length > 0) {
        const { error } = await supabase.from("user_permissions").insert(
          permRows.map((r) => ({
            user_id: selectedUserId,
            view_id: r.viewId,
            enabled: r.enabled,
            in_mobile_nav: r.inMobileNav,
          })),
        )
        if (error) throw error
      }
      setDirty(false)
      toast({ title: "Permisos guardados", description: "Los cambios se aplicarán en el próximo inicio de sesión del usuario." })
    } catch (err: any) {
      console.error("[v0] Error saving permissions:", err)
      toast({ title: "Error", description: err?.message ?? "No se pudieron guardar los permisos", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const handleRestablecer = async () => {
    if (selectedUserId === null) return
    const u = usuarios.find((u) => u.id === selectedUserId)
    if (!u) return
    setResetting(true)
    try {
      const supabase = createClient()
      await supabase.from("user_permissions").delete().eq("user_id", selectedUserId)
      setPermRows(buildDefaultRows(u.rol))
      setDirty(false)
      toast({ title: "Permisos restablecidos", description: "Se volvieron a los valores por defecto del rol." })
    } catch (err: any) {
      console.error("[v0] Error resetting permissions:", err)
      toast({ title: "Error", description: err?.message ?? "Error al restablecer", variant: "destructive" })
    } finally {
      setResetting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const usuarioSeleccionado = usuarios.find((u) => u.id === selectedUserId)

  return (
    <div className="space-y-4">
      {/* Banner informativo */}
      <div className="flex gap-2.5 rounded-xl border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40 p-3 text-sm text-blue-800 dark:text-blue-300">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="space-y-0.5">
          <p className="font-semibold text-xs">¿Qué puedes gestionar aquí?</p>
          <p className="text-xs text-blue-700 dark:text-blue-400">
            Activa o desactiva el acceso de cada usuario a módulos de su rol. Marca cuáles aparecen como acceso directo en la barra inferior del celular (máx. 5).
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[260px_1fr]">
        {/* Panel izquierdo: lista de usuarios */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-2">
            Seleccionar usuario
          </p>
          <div className="rounded-xl border border-border overflow-hidden max-h-[420px] overflow-y-auto">
            {usuarios.map((u) => {
              const isSelected = u.id === selectedUserId
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => handleSelectUser(u.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-b border-border last:border-0 transition-colors ${
                    isSelected ? "bg-brand/10 text-brand" : "hover:bg-muted/40"
                  }`}
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-bold">
                    {u.nombre.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium truncate leading-tight ${isSelected ? "text-brand" : ""}`}>{u.nombre}</p>
                    <p className="text-[10px] text-muted-foreground">{ROL_LABELS[u.rol] ?? u.rol}</p>
                  </div>
                  {isSelected && <CheckCircle2 className="h-4 w-4 shrink-0 text-brand" />}
                </button>
              )
            })}
          </div>
        </div>

        {/* Panel derecho: módulos del usuario */}
        <div className="space-y-3">
          {selectedUserId === null ? (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground">
              <Shield className="h-8 w-8 opacity-30" />
              <p className="text-sm">Selecciona un usuario para gestionar sus permisos</p>
            </div>
          ) : (
            <>
              {/* Cabecera usuario + contador móvil */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <p className="font-semibold text-sm">{usuarioSeleccionado?.nombre}</p>
                  <p className="text-xs text-muted-foreground">{ROL_LABELS[usuarioSeleccionado?.rol ?? ""] ?? usuarioSeleccionado?.rol} · {permRows.filter(r => r.enabled).length} de {permRows.length} módulos activos</p>
                </div>
                <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                  mobileCount >= 5
                    ? "border-destructive/40 bg-destructive/5 text-destructive"
                    : "border-border bg-muted/30 text-muted-foreground"
                }`}>
                  <Smartphone className="h-3.5 w-3.5" />
                  {mobileCount}/5 accesos directos
                </div>
              </div>

              {/* Módulos agrupados */}
              <div className="space-y-3">
                {/* Cabecera de columnas fija */}
                <div className="grid grid-cols-[1fr_80px_100px] gap-2 px-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Módulo</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground text-center">Acceso</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground text-center">Acceso directo</p>
                </div>
                {MODULE_GROUPS.map((group) => {
                  const groupRows = permRows.filter((r) => r.group === group)
                  if (groupRows.length === 0) return null
                  return (
                    <div key={group} className="rounded-xl border border-border overflow-hidden">
                      <div className="px-3 py-1.5 bg-muted/60 border-b border-border">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{group}</p>
                      </div>
                      <div className="divide-y divide-border">
                        {groupRows.map((row) => {
                          const mobileDisabled = !row.enabled || (mobileCount >= 5 && !row.inMobileNav)
                          return (
                            <div
                              key={row.viewId}
                              className="grid grid-cols-[1fr_80px_100px] gap-2 items-center px-3 py-2.5 transition-colors"
                            >
                              <div className={`min-w-0 transition-opacity ${!row.enabled ? "opacity-40" : ""}`}>
                                <p className="text-sm font-medium truncate leading-tight">{row.label}</p>
                                <p className="text-[10px] text-muted-foreground truncate">{row.description}</p>
                              </div>
                              <div className="flex justify-center">
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={row.enabled}
                                  aria-label={`Acceso a ${row.label}`}
                                  onClick={() => toggleEnabled(row.viewId)}
                                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${
                                    row.enabled
                                      ? "border-brand bg-brand focus-visible:ring-brand"
                                      : "border-border bg-muted focus-visible:ring-border"
                                  }`}
                                >
                                  <span
                                    className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md ring-0 transition-transform ${
                                      row.enabled ? "translate-x-5" : "translate-x-0.5"
                                    }`}
                                  />
                                </button>
                              </div>
                              <div className="flex justify-center">
                                <Checkbox
                                  checked={row.inMobileNav}
                                  disabled={mobileDisabled}
                                  onCheckedChange={() => toggleMobileNav(row.viewId)}
                                  aria-label={`Acceso directo a ${row.label}`}
                                  className="h-4 w-4"
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Botones */}
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRestablecer}
                  disabled={resetting || saving}
                  className="gap-1.5 h-8 text-xs"
                >
                  {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  Restablecer defaults
                </Button>
                <Button
                  size="sm"
                  onClick={handleGuardar}
                  disabled={saving || resetting || !dirty}
                  className="gap-1.5 h-8 text-xs"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Guardar permisos
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Tab Contactos Chat ───────────────────────────────────────────────────────

function ContactosChatTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [allowedIds, setAllowedIds] = useState<Set<number>>(new Set())
  const [hasRestrictions, setHasRestrictions] = useState(false)
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from("usuarios")
      .select("id, usuario, nombre, rol, activo")
      .eq("activo", true)
      .order("nombre")
      .then(({ data }: { data: Usuario[] | null }) => { setUsuarios((data ?? [])); setLoadingUsers(false) })
  }, [])

  const loadContacts = useCallback(async (userId: number) => {
    setLoadingContacts(true)
    setDirty(false)
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from("chat_allowed_contacts")
        .select("allowed_user_id")
        .eq("user_id", userId)
      if (!data || data.length === 0) {
        setHasRestrictions(false)
        setAllowedIds(new Set())
      } else {
        setHasRestrictions(true)
        setAllowedIds(new Set(data.map((r: { allowed_user_id: number }) => r.allowed_user_id)))
      }
    } finally {
      setLoadingContacts(false)
    }
  }, [])

  useEffect(() => {
    if (selectedUserId) loadContacts(selectedUserId)
  }, [selectedUserId, loadContacts])

  const toggleContact = (uid: number) => {
    setAllowedIds((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
    setHasRestrictions(true)
    setDirty(true)
  }

  const handleRestablecer = async () => {
    if (!selectedUserId) return
    try {
      setSaving(true)
      const supabase = createClient()
      await supabase.from("chat_allowed_contacts").delete().eq("user_id", selectedUserId)
      setHasRestrictions(false)
      setAllowedIds(new Set())
      setDirty(false)
      toast({ title: "Restablecido", description: "El usuario puede ver a todos los contactos." })
    } catch {
      toast({ title: "Error", description: "No se pudo restablecer.", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const handleGuardar = async () => {
    if (!selectedUserId) return
    try {
      setSaving(true)
      const supabase = createClient()
      await supabase.from("chat_allowed_contacts").delete().eq("user_id", selectedUserId)
      if (allowedIds.size > 0) {
        await supabase.from("chat_allowed_contacts").insert(
          [...allowedIds].map((uid) => ({ user_id: selectedUserId, allowed_user_id: uid }))
        )
      }
      setDirty(false)
      toast({ title: "Guardado", description: hasRestrictions && allowedIds.size === 0 ? "El usuario no puede ver ningún contacto." : "Contactos permitidos actualizados." })
    } catch {
      toast({ title: "Error", description: "No se pudo guardar.", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const selectedUser = usuarios.find((u) => u.id === selectedUserId)
  const otherUsers = usuarios.filter((u) => u.id !== selectedUserId)

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
      {/* Panel selector de usuario */}
      <div className="space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-1 mb-2">Usuarios</p>
        {loadingUsers ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
            {usuarios.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => { setSelectedUserId(u.id); setDirty(false) }}
                className={`w-full text-left rounded-lg border px-3 py-2 text-sm transition-all ${
                  selectedUserId === u.id
                    ? "border-brand bg-brand/10 font-semibold"
                    : "border-transparent hover:border-border hover:bg-muted/50"
                }`}
              >
                <p className="font-medium leading-tight">{u.nombre}</p>
                <p className={`text-[10px] mt-0.5 px-1.5 rounded-full inline-block ${ROL_BADGE[u.rol] ?? ""}`}>{ROL_LABELS[u.rol] ?? u.rol}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Panel de contactos permitidos */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        {!selectedUser ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-2">
            <MessageSquare className="h-8 w-8 opacity-30" />
            <p className="text-sm">Selecciona un usuario para configurar<br />sus contactos de chat visibles</p>
          </div>
        ) : loadingContacts ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-sm">{selectedUser.nombre}</p>
                <p className="text-[11px] text-muted-foreground">
                  {!hasRestrictions
                    ? "Sin restricciones — ve a todos los usuarios"
                    : allowedIds.size === 0
                    ? "No puede ver ningún contacto"
                    : `Puede ver ${allowedIds.size} usuario${allowedIds.size !== 1 ? "s" : ""}`}
                </p>
              </div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${!hasRestrictions ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                {!hasRestrictions ? "Ver todos" : "Restringido"}
              </span>
            </div>

            <div className="divide-y divide-border rounded-lg border overflow-hidden max-h-[50vh] overflow-y-auto">
              {otherUsers.map((u) => {
                const checked = !hasRestrictions || allowedIds.has(u.id)
                return (
                  <div
                    key={u.id}
                    onClick={() => toggleContact(u.id)}
                    className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors select-none"
                  >
                    <Checkbox
                      checked={checked}
                      className="h-4 w-4 shrink-0 pointer-events-none"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-tight">{u.nombre}</p>
                      <p className={`text-[10px] mt-0.5 px-1.5 rounded-full inline-block ${ROL_BADGE[u.rol] ?? ""}`}>{ROL_LABELS[u.rol] ?? u.rol}</p>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={handleRestablecer} disabled={saving || !hasRestrictions} className="gap-1.5 h-8 text-xs">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Restablecer (ver todos)
              </Button>
              <Button size="sm" onClick={handleGuardar} disabled={saving || !dirty} className="gap-1.5 h-8 text-xs">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Guardar
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function GestionUsuariosRutas() {
  return (
    <div className="space-y-4 md:space-y-6">
      {/* Encabezado */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-border overflow-hidden p-0.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
        </div>
        <div>
          <h2 className="text-base md:text-lg font-bold leading-tight">Gestión de Usuarios y Rutas</h2>
          <p className="text-[11px] text-muted-foreground">Crea y administra usuarios, rutas y sus asignaciones</p>
        </div>
      </div>

      <Tabs defaultValue="usuarios" className="space-y-4">
        <TabsList className="grid w-full grid-cols-5 h-9">
          <TabsTrigger value="usuarios" className="gap-1 text-xs">
            <Users className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Usuarios</span>
          </TabsTrigger>
          <TabsTrigger value="rutas" className="gap-1 text-xs">
            <RouteIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Rutas</span>
          </TabsTrigger>
          <TabsTrigger value="asignaciones" className="gap-1 text-xs">
            <Link2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Asignaciones</span>
          </TabsTrigger>
          <TabsTrigger value="permisos" className="gap-1 text-xs">
            <Shield className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Permisos</span>
          </TabsTrigger>
          <TabsTrigger value="contactos-chat" className="gap-1 text-xs">
            <MessageSquare className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Chat</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="usuarios">
          <UsuariosTab />
        </TabsContent>
        <TabsContent value="rutas">
          <RutasTab />
        </TabsContent>
        <TabsContent value="asignaciones">
          <AsignacionesTab />
        </TabsContent>
        <TabsContent value="permisos">
          <PermisosTab />
        </TabsContent>
        <TabsContent value="contactos-chat">
          <ContactosChatTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
