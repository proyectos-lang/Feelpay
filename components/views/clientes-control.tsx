"use client"

/**
 * components/views/clientes-control.tsx
 * ---------------------------------------------------------------------------
 * La pestaña CLIENTES de Control Total.
 *
 * QUÉ RESUELVE
 * Hasta ahora los datos de un cliente solo se podían escribir en UN sitio: el
 * formulario de venta, y solo mientras se creaba la venta. Después de eso no
 * había forma de corregir un teléfono mal tecleado, una dirección que cambió
 * o un apodo con un error de dedo — ni de agregar el segundo apodo a alguien
 * que ya existía. `Ver Clientes` es de solo lectura y no hay pantalla de
 * edición en toda la app.
 *
 * Acá se ve la ficha completa de cada cliente de la ruta seleccionada y se
 * edita. Vive en Control Total y no en el módulo del cobrador a propósito:
 * corregir la identidad de un cliente —su documento, su nombre— es una
 * atribución de secretaría, igual que mover una venta o fechar un gasto.
 *
 * QUÉ NO SE EDITA, Y POR QUÉ
 *   · `ruta` — mover un cliente de ruta arrastra sus préstamos, sus gestiones
 *     y su plata. Es otra operación, no un campo de un formulario.
 *   · `tiene_prestamo_activo` — es un derivado que mantiene la base.
 *   · la ubicación (`latitud`/`longitud`) — la captura el cobrador en la
 *     calle con el GPS; escribirla a mano no tendría de dónde sacar el dato.
 *
 * EL DOCUMENTO SÍ SE EDITA, y es el campo delicado: es único por ruta desde el
 * script 095. Si se repite, la base lo rechaza y el mensaje lo dice — no se
 * pierde nada, pero conviene saberlo antes de tocarlo.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Search, MapPin, Pencil, User, AlertCircle, RefreshCw } from "lucide-react"

// Lo que se muestra y se edita de un cliente. `id` y `ruta` van para poder
// escribir y para saber a qué unidad pertenece; no son editables.
interface ClienteRow {
  id: string
  ruta: number
  documento: string | null
  nombre_completo: string | null
  apodo: string | null
  apodo_2: string | null
  telefono: string | null
  telefono2: string | null
  direccion: string | null
  sector: string | null
  tipo_comercio: string | null
  ref1_nombre: string | null
  ref1_telefono: string | null
  ref1_direccion: string | null
  tiene_prestamo_activo: boolean | null
}

const COLUMNAS =
  "id, ruta, documento, nombre_completo, apodo, apodo_2, telefono, telefono2, " +
  "direccion, sector, tipo_comercio, ref1_nombre, ref1_telefono, ref1_direccion, " +
  "tiene_prestamo_activo"

/** Los campos del formulario, en el orden en que se leen. */
const CAMPOS: { k: keyof ClienteRow; label: string; ayuda?: string; mayus?: boolean }[] = [
  { k: "documento", label: "Documento", ayuda: "Único dentro de la ruta" },
  { k: "nombre_completo", label: "Nombre completo", mayus: true },
  { k: "apodo", label: "Apodo", mayus: true, ayuda: "Con el que se le conoce en la calle" },
  { k: "apodo_2", label: "Apodo 2", mayus: true, ayuda: "Opcional. Cada préstamo elige con cuál se ve" },
  { k: "telefono", label: "Teléfono" },
  { k: "telefono2", label: "Teléfono 2" },
  { k: "direccion", label: "Dirección", mayus: true },
  { k: "sector", label: "Sector", mayus: true },
  { k: "tipo_comercio", label: "Tipo de comercio", mayus: true },
  { k: "ref1_nombre", label: "Referencia · nombre", mayus: true },
  { k: "ref1_telefono", label: "Referencia · teléfono" },
  { k: "ref1_direccion", label: "Referencia · dirección", mayus: true },
]

interface Props {
  /** La ruta que el buscador de Control Total tiene puesta. */
  rutaFiltro: number | "todas"
  onRutaChange: (v: number | "todas") => void
  rutas: { id: number; nombre: string }[]
}

export function ClientesControl({ rutaFiltro, onRutaChange, rutas }: Props) {
  const { toast } = useToast()
  const [filas, setFilas] = useState<ClienteRow[]>([])
  const [cargando, setCargando] = useState(true)
  const [busqueda, setBusqueda] = useState("")
  const [editando, setEditando] = useState<ClienteRow | null>(null)
  const [form, setForm] = useState<Partial<ClienteRow>>({})
  const [guardando, setGuardando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      let q = createClient().from("clients").select(COLUMNAS).order("apodo", { ascending: true })
      // Sin RLS, el filtro por ruta lo pone la consulta.
      if (rutaFiltro !== "todas") q = q.eq("ruta", rutaFiltro)
      const { data, error } = await q.limit(2000)
      if (error) throw error
      setFilas((data ?? []) as unknown as ClienteRow[])
    } catch (err) {
      console.error("[v0] ClientesControl cargar:", err)
      toast({
        title: "No se pudieron cargar los clientes",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      })
    } finally {
      setCargando(false)
    }
  }, [rutaFiltro, toast])

  useEffect(() => { void cargar() }, [cargar])

  // La búsqueda mira los cuatro campos con que se identifica a alguien: los
  // dos apodos, el nombre y el documento. Buscar solo por apodo obligaba a
  // saber CUÁL de los dos tiene puesto.
  const visibles = useMemo(() => {
    const t = busqueda.trim().toLowerCase()
    if (!t) return filas
    return filas.filter((c) =>
      [c.apodo, c.apodo_2, c.nombre_completo, c.documento]
        .some((v) => (v ?? "").toLowerCase().includes(t)),
    )
  }, [filas, busqueda])

  const abrir = (c: ClienteRow) => {
    setEditando(c)
    setForm({ ...c })
  }

  const guardar = async () => {
    if (!editando) return
    // El documento y el nombre son lo mínimo para identificar a alguien: sin
    // ellos la ficha deja de servir para lo que existe.
    if (!String(form.documento ?? "").trim()) {
      toast({ title: "Falta el documento", variant: "destructive" })
      return
    }
    if (!String(form.nombre_completo ?? "").trim()) {
      toast({ title: "Falta el nombre completo", variant: "destructive" })
      return
    }
    setGuardando(true)
    try {
      // Se manda solo lo editable. Vacío se guarda como NULL —y no como cadena
      // vacía— para que `apodoSiAporta` y los `NULLIF` de la base sigan
      // funcionando igual que con un cliente recién creado.
      const cambios: Record<string, string | null> = {}
      for (const { k } of CAMPOS) {
        const v = String(form[k] ?? "").trim()
        cambios[k] = v === "" ? null : v
      }
      const { error } = await createClient()
        .from("clients")
        .update({ ...cambios, updated_at: new Date().toISOString() })
        .eq("id", editando.id)
      if (error) throw error

      setFilas((prev) =>
        prev.map((c) => (c.id === editando.id ? ({ ...c, ...cambios } as ClienteRow) : c)),
      )
      toast({ title: "Cliente actualizado" })
      setEditando(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[v0] ClientesControl guardar:", msg)
      // 23505 = llave única. El documento se repite dentro de la ruta, que es
      // el único choque posible acá; se dice con todas las letras en vez de
      // mostrar el error crudo de Postgres.
      const duplicado = msg.includes("23505") || msg.toLowerCase().includes("duplicate")
      toast({
        title: duplicado ? "Ese documento ya existe en esta ruta" : "No se pudo guardar",
        description: duplicado
          ? "Dos clientes de la misma unidad no pueden tener el mismo documento."
          : msg,
        variant: "destructive",
      })
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* Buscador + ruta, con la misma forma que la pestaña de Ventas. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por apodo, nombre o documento..."
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            className="h-9 pl-8"
          />
        </div>
        <Select
          value={String(rutaFiltro)}
          onValueChange={(v) => onRutaChange(v === "todas" ? "todas" : Number(v))}
        >
          <SelectTrigger className="h-9 w-full sm:w-52">
            <MapPin className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <SelectValue placeholder="Ruta" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas las rutas</SelectItem>
            {rutas.map((r) => (
              <SelectItem key={r.id} value={String(r.id)}>{r.nombre}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" className="h-9 gap-1.5 sm:shrink-0" onClick={() => void cargar()}>
          <RefreshCw className={`h-3.5 w-3.5 ${cargando ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </div>

      {cargando ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : visibles.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
          <AlertCircle className="h-8 w-8 opacity-40" />
          <span className="text-sm">
            {busqueda ? "Ningún cliente coincide con la búsqueda." : "Esta ruta no tiene clientes."}
          </span>
        </div>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            {visibles.length} {visibles.length === 1 ? "cliente" : "clientes"}
            {busqueda && filas.length !== visibles.length && ` de ${filas.length}`}
          </p>
          <ul className="divide-y rounded-lg border">
            {visibles.map((c) => (
              <li key={c.id} className="flex items-start gap-2 p-2.5">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand/10">
                  <User className="h-4 w-4 text-brand" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold leading-tight">
                      {c.apodo || c.nombre_completo || "Sin nombre"}
                    </span>
                    {/* El segundo apodo se ve acá: es el dato que no existía en
                        ninguna pantalla y por el que se pidió esta pestaña. */}
                    {c.apodo_2 && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[9px] font-semibold">
                        {c.apodo_2}
                      </Badge>
                    )}
                    {c.tiene_prestamo_activo && (
                      <Badge className="border-0 bg-success/15 px-1.5 py-0 text-[9px] text-success">
                        con crédito
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {c.nombre_completo}
                    {c.documento ? ` · ${c.documento}` : ""}
                    {c.telefono ? ` · ${c.telefono}` : ""}
                  </p>
                  {rutaFiltro === "todas" && (
                    <p className="text-[10px] text-muted-foreground">Ruta {c.ruta}</p>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 shrink-0"
                  onClick={() => abrir(c)}
                  title="Editar los datos del cliente"
                  aria-label={`Editar ${c.apodo || c.nombre_completo || "cliente"}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── La ficha ────────────────────────────────────────────────────── */}
      <Dialog open={!!editando} onOpenChange={(o) => { if (!o) setEditando(null) }}>
        <DialogContent className="flex max-h-[88vh] max-w-lg flex-col p-4">
          <DialogHeader>
            <DialogTitle className="text-base">Editar cliente</DialogTitle>
            <DialogDescription className="text-xs">
              Ruta {editando?.ruta} · los cambios se ven en toda la app.
            </DialogDescription>
          </DialogHeader>

          <div className="grid flex-1 gap-3 overflow-y-auto py-1 sm:grid-cols-2">
            {CAMPOS.map(({ k, label, ayuda, mayus }) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`f-${k}`} className="text-xs">
                  {label}
                  {(k === "documento" || k === "nombre_completo") && (
                    <span className="ml-0.5 text-destructive">*</span>
                  )}
                </Label>
                <Input
                  id={`f-${k}`}
                  value={String(form[k] ?? "")}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      [k]: mayus ? e.target.value.toUpperCase() : e.target.value,
                    }))
                  }
                  className={`h-9 text-sm ${mayus ? "uppercase" : ""}`}
                />
                {ayuda && <p className="text-[10px] leading-snug text-muted-foreground">{ayuda}</p>}
              </div>
            ))}
          </div>

          <DialogFooter className="gap-2 border-t pt-3">
            <Button variant="outline" onClick={() => setEditando(null)} disabled={guardando}>
              Cancelar
            </Button>
            <Button onClick={() => void guardar()} disabled={guardando} className="gap-1.5">
              {guardando && <Loader2 className="h-4 w-4 animate-spin" />}
              Guardar cambios
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
