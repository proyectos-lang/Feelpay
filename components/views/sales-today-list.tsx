"use client"

/**
 * SalesTodayList
 * ---------------
 * Vista informativa de las ventas (préstamos) creados HOY en la ruta
 * actual. Se monta dentro del módulo de Pagos → Clientes activos →
 * pestaña "Registrar Ventas".
 *
 * Por qué es de solo lectura
 * --------------------------
 * El formulario de creación (NewLoan) sigue disponible desde el menú
 * principal "Nueva Venta". Aquí mostramos un listado consolidado del
 * día para que el cobrador / asesor pueda revisar rápidamente lo que
 * ya quedó registrado sin tener que ir a otra pantalla.
 *
 * Fuente de los datos
 * -------------------
 * Tabla `loans` con join inline a `clients` (nombre_completo y apodo),
 * filtrada por:
 *   - `ruta = currentRutaId` (RLS adicional aplicada server-side)
 *   - `fecha_creacion` entre el inicio y fin del día local de Bogotá.
 *
 * Filtrar por timestamp del día Colombia (no UTC) evita que una venta
 * registrada a las 11pm hora local aparezca como "ayer" en clientes
 * que están en zonas con offset distinto a -05.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, RefreshCcw, ShoppingCart, User, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getSupabaseSafe } from "@/lib/api-helper"
import { EditSaleDialog } from "@/components/views/edit-sale-dialog"

/**
 * Formatea un número como moneda COP sin decimales. Inline aquí para
 * no depender de un helper externo y mantener el componente autocontenido.
 */
const formatCurrency = (value: number): string =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0)

interface SaleRow {
  id: string
  valor: number
  valor_cuota: number
  numero_cuotas: number
  tipo_venta: string | null
  tipo_amortizacion: string | null
  frecuencia_pago: string | null
  estado: string | null
  fecha_creacion: string
  clients: {
    nombre_completo: string | null
    apodo: string | null
  } | null
}

interface SalesTodayListProps {
  /** ID de la ruta activa. RLS lo aplica de todos modos, pero filtrar
   *  client-side reduce datos en respuesta. */
  currentRutaId: number
  /** Callback opcional invocado tras cada fetch exitoso con el numero
   *  total de ventas del dia. El padre lo usa para mostrar el contador
   *  en el badge del tab "Ventas del día", igual que Pendientes y
   *  Gestionados. */
  onCountChange?: (count: number) => void
}

/**
 * Devuelve el inicio y fin del día local de Bogotá como timestamps ISO
 * con offset -05:00. Usamos string-building en vez de `Date` UTC para
 * evitar drift por daylight saving o por la zona del cliente.
 */
function getColombiaDayBounds(): { startISO: string; endISO: string } {
  const ymd = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" })
  return {
    startISO: `${ymd}T00:00:00-05:00`,
    endISO: `${ymd}T23:59:59-05:00`,
  }
}

// Mapea el codigo interno de `loans.frecuencia_pago` (en ingles, tal como
// lo usa el RPC `crear_venta_atomica`) al label en espanol mostrado al
// usuario. Si llega un valor desconocido, lo capitalizamos como fallback
// para no romper el render.
function frecuenciaLabel(freq: string): string {
  switch (freq) {
    case "daily":
      return "Diario"
    case "weekly":
      return "Semanal"
    case "biweekly":
      return "Quincenal"
    case "monthly":
      return "Mensual"
    default:
      return freq.charAt(0).toUpperCase() + freq.slice(1)
  }
}

export function SalesTodayList({ currentRutaId, onCountChange }: SalesTodayListProps) {
  const [sales, setSales] = useState<SaleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Estado del dialogo de edicion. Guarda la fila seleccionada para
  // hidratar el formulario al abrir.
  const [editingSale, setEditingSale] = useState<SaleRow | null>(null)

  const fetchSales = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = await getSupabaseSafe()

      // SELECT directo sobre `loans` filtrado por ruta y rango de fecha
      // del dia en zona Colombia. (RLS eliminado.)
      const { startISO, endISO } = getColombiaDayBounds()
      const { data, error: queryError } = await supabase
        .from("loans")
        .select(
          "id, valor, valor_cuota, numero_cuotas, tipo_venta, tipo_amortizacion, frecuencia_pago, estado, fecha_creacion, clients(nombre_completo, apodo)",
        )
        .eq("ruta", currentRutaId)
        .gte("fecha_creacion", startISO)
        .lte("fecha_creacion", endISO)
        .order("fecha_creacion", { ascending: false })

      if (queryError) throw queryError
      const rows = (data ?? []) as unknown as SaleRow[]
      setSales(rows)
      // Notificar al padre el conteo para alimentar el badge del tab.
      onCountChange?.(rows.length)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error("[v0] SalesTodayList fetch error:", msg)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [currentRutaId, onCountChange])

  useEffect(() => {
    void fetchSales()
  }, [fetchSales])

  // Total acumulado del día (suma de `valor` = capital prestado).
  const totalDia = sales.reduce((acc, s) => acc + Number(s.valor ?? 0), 0)

  return (
    <div className="space-y-3">
      {/* Encabezado con total y acción de refresh */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShoppingCart className="h-4 w-4 text-primary" />
          <h3 className="text-sm md:text-base font-semibold">Ventas de hoy</h3>
          <Badge variant="secondary" className="text-[11px]">
            {sales.length}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void fetchSales()}
          disabled={loading}
          className="h-7 px-2"
          aria-label="Actualizar listado de ventas"
        >
          <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Resumen: total del día */}
      {!loading && sales.length > 0 && (
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <span className="text-[12px] md:text-sm text-muted-foreground">Total prestado hoy</span>
              <span className="text-base md:text-lg font-bold text-primary">{formatCurrency(totalDia)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Cargando ventas...</span>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <Card className="border-destructive/40">
          <CardContent className="p-3 text-sm text-destructive">
            No se pudo cargar el listado: {error}
          </CardContent>
        </Card>
      )}

      {/* Vacío */}
      {!loading && !error && sales.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No se han registrado ventas el día de hoy en esta ruta.
          </CardContent>
        </Card>
      )}

      {/* Listado */}
      {!loading && !error && sales.length > 0 && (
        <div className="space-y-2">
          {sales.map((s) => {
            const hora = new Date(s.fecha_creacion).toLocaleTimeString("es-CO", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "America/Bogota",
            })
            const nombre = s.clients?.nombre_completo ?? "Cliente"
            const apodo = s.clients?.apodo
            return (
              <Card key={s.id} className="hover:bg-muted/40 transition-colors">
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 mb-1">
                        <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <p className="text-[13px] md:text-sm font-semibold truncate">
                          {nombre}
                          {apodo ? <span className="text-muted-foreground font-normal"> ({apodo})</span> : null}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] md:text-xs text-muted-foreground">
                        <span>
                          {s.numero_cuotas} cuotas × {formatCurrency(s.valor_cuota)}
                        </span>
                        {s.frecuencia_pago && (
                          <span>{frecuenciaLabel(s.frecuencia_pago)}</span>
                        )}
                        {s.tipo_venta && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5 capitalize">
                            {s.tipo_venta}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0 flex flex-col items-end gap-1">
                      <p className="text-sm md:text-base font-bold">{formatCurrency(s.valor)}</p>
                      <p className="text-[10px] md:text-[11px] text-muted-foreground">{hora}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingSale(s)}
                        className="h-6 px-2 text-[10px] md:text-[11px] gap-1"
                        aria-label="Editar venta"
                      >
                        <Pencil className="h-3 w-3" />
                        Editar
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Dialogo de edicion. Se monta una sola vez fuera del map para
          evitar duplicar el componente por cada venta. La fila activa
          se pasa via prop `sale`. */}
      <EditSaleDialog
        open={editingSale !== null}
        onOpenChange={(o) => {
          if (!o) setEditingSale(null)
        }}
        sale={
          editingSale
            ? {
                id: editingSale.id,
                valor: editingSale.valor,
                valor_cuota: editingSale.valor_cuota,
                numero_cuotas: editingSale.numero_cuotas,
                tipo_amortizacion: editingSale.tipo_amortizacion,
                frecuencia_pago: editingSale.frecuencia_pago,
                tipo_venta: editingSale.tipo_venta,
                clientName:
                  editingSale.clients?.apodo ||
                  editingSale.clients?.nombre_completo ||
                  undefined,
              }
            : null
        }
        onSaved={() => void fetchSales()}
      />
    </div>
  )
}
