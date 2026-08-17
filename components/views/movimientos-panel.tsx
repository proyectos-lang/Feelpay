"use client"

/**
 * Panel de ingresos, gastos y retiros de una ruta.
 *
 * Lo usan Auditoría 360 (solo lectura) y Control Total (editable). Es el mismo
 * panel a propósito: si fueran dos listas distintas, tarde o temprano una
 * mostraría un total que la otra no, y ese es exactamente el tipo de
 * discrepancia que hace desconfiar de los números.
 *
 * Los dos módulos que lo alojan son de préstamos, pero estos movimientos NO
 * cuelgan de un préstamo: `gastosregistros` no tiene `loan_id`. Se filtran por
 * ruta y rango de fechas, así que el panel vive como pestaña propia y no
 * dentro del detalle de una venta.
 */

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, TrendingUp, TrendingDown, Wallet, Pencil, Search, PencilLine } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { fmtMoneda, fmtFechaHora } from "@/lib/gestion-core"
import { todayColombia } from "@/lib/colombia-date"
import {
  getMovimientos, totalesPorTipo, movimientoEditado, movimientoAbierto,
  TIPOS_MOVIMIENTO, type Movimiento,
} from "@/lib/movimientos"
import { EditMovimientoDialog } from "@/components/views/edit-movimiento-dialog"

interface Props {
  /** Ruta a consultar. "todas" solo se usa desde los módulos de secretaría. */
  rutaId: number | "todas"
  /** true = muestra el botón de editar en cada fila (Control Total). */
  editable?: boolean
  /**
   * Rutas disponibles. Si vienen, el panel dibuja su propio selector: los dos
   * módulos que lo alojan tienen el suyo dentro de la pestaña de préstamos, y
   * desde acá no se alcanza.
   */
  rutas?: { id: number; nombre: string }[]
  onRutaChange?: (ruta: number | "todas") => void
}

const ICONO_TIPO: Record<string, React.ReactNode> = {
  Ingreso: <TrendingUp className="h-3.5 w-3.5 text-green-600" />,
  Gasto: <TrendingDown className="h-3.5 w-3.5 text-red-600" />,
  Retiro: <Wallet className="h-3.5 w-3.5 text-blue-600" />,
}

function BadgeEstado({ estado }: { estado: string }) {
  // 'NA' no es "pendiente": significa que no necesitó aprobación y que ya
  // cuenta como plata autorizada. Se nombra distinto para no confundirlos.
  const mapa: Record<string, { texto: string; clase: string }> = {
    aprobado: { texto: "Aprobado", clase: "bg-green-500 text-white" },
    rechazado: { texto: "Rechazado", clase: "bg-red-500 text-white" },
    "por aprobar": { texto: "Pendiente", clase: "bg-yellow-500 text-white" },
    NA: { texto: "Sin requerir", clase: "bg-muted text-muted-foreground" },
  }
  const m = mapa[estado] ?? { texto: estado, clase: "bg-muted text-muted-foreground" }
  return <Badge className={`${m.clase} text-[9px] md:text-[10px] font-semibold`}>{m.texto}</Badge>
}

export function MovimientosPanel({ rutaId, editable = false, rutas, onRutaChange }: Props) {
  const { toast } = useToast()
  const hoy = todayColombia()
  const [desde, setDesde] = useState(hoy)
  const [hasta, setHasta] = useState(hoy)
  const [tipoFiltro, setTipoFiltro] = useState<string>("todos")
  const [busqueda, setBusqueda] = useState("")
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [cargando, setCargando] = useState(true)
  const [editando, setEditando] = useState<Movimiento | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      setMovs(await getMovimientos({ rutaId, desde, hasta }))
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "No se pudieron cargar los movimientos",
        variant: "destructive",
      })
      setMovs([])
    } finally {
      setCargando(false)
    }
  }, [rutaId, desde, hasta, toast])

  useEffect(() => { cargar() }, [cargar])

  const filtrados = movs.filter((m) => {
    if (tipoFiltro !== "todos" && m.tipo !== tipoFiltro) return false
    if (!busqueda) return true
    const t = busqueda.toLowerCase()
    return (
      (m.concepto ?? "").toLowerCase().includes(t) ||
      (m.observacion ?? "").toLowerCase().includes(t)
    )
  })
  const totales = totalesPorTipo(filtrados)

  return (
    <div className="space-y-3">
      {/* Filtros */}
      <Card>
        <CardContent className="p-3 space-y-2">
          {rutas && onRutaChange && (
            <div className="space-y-1">
              <Label className="text-[11px]">Ruta</Label>
              <Select
                value={String(rutaId)}
                onValueChange={(v) => onRutaChange(v === "todas" ? "todas" : Number(v))}
              >
                <SelectTrigger className="h-8 text-xs w-full sm:w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="todas" className="text-xs">Todas las rutas</SelectItem>
                  {rutas.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)} className="text-xs">{r.nombre}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px]">Desde</Label>
              <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Hasta</Label>
              <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Tipo</Label>
              <Select value={tipoFiltro} onValueChange={setTipoFiltro}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="todos" className="text-xs">Todos</SelectItem>
                  {TIPOS_MOVIMIENTO.map((t) => (
                    <SelectItem key={t} value={t} className="text-xs">{t}s</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Buscar</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  placeholder="Concepto u observación"
                  className="h-8 text-xs pl-7"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Totales del rango */}
      <div className="grid grid-cols-3 gap-2">
        {TIPOS_MOVIMIENTO.map((t) => (
          <Card key={t}>
            <CardContent className="p-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {ICONO_TIPO[t]} {t}s
              </div>
              <div className="font-semibold tabular-nums text-sm md:text-base">{fmtMoneda(totales[t])}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Listado */}
      <Card>
        <CardContent className="p-0">
          {cargando ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : filtrados.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No hay movimientos en este rango
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Fecha</th>
                    <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Concepto</th>
                    <th className="px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Valor</th>
                    <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hidden md:table-cell">Admin</th>
                    <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hidden md:table-cell">Secretaria</th>
                    <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hidden lg:table-cell">Observación</th>
                    {editable && <th className="px-2 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtrados.map((m) => (
                    <tr key={m.id} className="hover:bg-muted/20 transition-colors align-top">
                      <td className="px-2 py-2 text-[11px] whitespace-nowrap">{fmtFechaHora(m.fechahorasol)}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1.5">
                          {ICONO_TIPO[m.tipo]}
                          <span className="text-[12px] font-medium">{m.concepto}</span>
                        </div>
                        {/* El rastro de edición va junto al concepto: es lo
                            primero que uno mira cuando una caja no cuadra. */}
                        {movimientoEditado(m) && (
                          <span
                            className="mt-0.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[9px] font-semibold bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
                            title={`Editado por ${m.editado_por} el ${fmtFechaHora(m.fechahoraedicion)}${
                              m.valor_anterior !== null ? ` · antes: ${fmtMoneda(m.valor_anterior)}` : ""
                            }`}
                          >
                            <PencilLine className="h-2.5 w-2.5" />
                            editado
                            {m.valor_anterior !== null && ` · antes ${fmtMoneda(m.valor_anterior)}`}
                          </span>
                        )}
                        <div className="md:hidden mt-1 flex gap-1">
                          <BadgeEstado estado={m.estadoadmin} />
                          <BadgeEstado estado={m.estadosecre} />
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums text-[12px] whitespace-nowrap">
                        {fmtMoneda(m.valor)}
                      </td>
                      <td className="px-2 py-2 hidden md:table-cell">
                        <BadgeEstado estado={m.estadoadmin} />
                        {m.adminaprobo && (
                          <p className="text-[9px] text-muted-foreground mt-0.5">{m.adminaprobo}</p>
                        )}
                      </td>
                      <td className="px-2 py-2 hidden md:table-cell">
                        <BadgeEstado estado={m.estadosecre} />
                        {m.secretariaaprobo && (
                          <p className="text-[9px] text-muted-foreground mt-0.5">{m.secretariaaprobo}</p>
                        )}
                      </td>
                      <td className="px-2 py-2 text-[11px] text-muted-foreground hidden lg:table-cell max-w-[220px]">
                        {m.observacion || "—"}
                      </td>
                      {editable && (
                        <td className="px-2 py-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={movimientoAbierto(m) ? "Editar" : "Editar (ya fue resuelto)"}
                            onClick={() => setEditando(m)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {editable && (
        <EditMovimientoDialog
          movimiento={editando}
          open={editando !== null}
          onOpenChange={(o) => !o && setEditando(null)}
          comoAsesor={false}
          onSaved={cargar}
        />
      )}
    </div>
  )
}
