"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
 import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  MapPin,
  RefreshCw,
  Calendar as CalendarIcon,
  Banknote,
  CheckCircle2,
  XCircle,
  Clock,
  MapPinOff,
  Loader2,
  Route,
  AlertTriangle,
  ShieldCheck,
  TrendingUp,
  Receipt,
  Wallet,
  ShoppingCart,
  ReceiptText,
  Eye,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { DetalleClientesDialog } from "@/components/detalle-clientes-dialog"
import { PagosDelDiaDialog, type FuentePagos } from "@/components/pagos-del-dia-dialog"
import {
  todayColombia,
  horaColombia,
  colapsarPorCliente,
  type TipoGestion,
} from "@/lib/gestion-core"
import type { MapPoint } from "./admin-route-monitor-map"

// Map is dynamically imported so Leaflet does not try to run during SSR.
const AdminRouteMonitorMap = dynamic(() => import("./admin-route-monitor-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] w-full items-center justify-center rounded-xl bg-muted/40 shadow-steel">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  ),
})

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────
type MonitoreoRuta = {
  ruta_id: number
  estado_ruta: "abierta" | "cerrada" | string | null
  aprobacion_admin: "pendiente" | "aprobado" | string | null
  total_recaudado: number | null
  /** Script 071: la plata que entró POR LA CALLE. Es la que responde el
   *  cobrador y la que se muestra acá. */
  recaudo_campo: number | null
  /** El resto: correcciones de secretaría sobre cuotas de otros días. Es
   *  plata real, pero no se recaudó hoy ni en esta ruta. No se esconde —
   *  se muestra aparte para que el número de arriba sea el del cobrador. */
  recaudo_ajuste: number | null
  pagos_exitosos: number | null
  visitas_sin_pago: number | null
  /** Script 060: la CARTERA de esa ruta ese día que quedó sin gestionar —
   *  todo el que debía, no solo el que vencía. Es lo mismo que ve el cobrador
   *  en su lista. */
  pendientes_por_visitar: number | null
  /** Denominador: sin él, "48 pendientes" no dice si la ruta va atrasada o si
   *  simplemente tiene 300 clientes. */
  cartera_activa: number | null
  /** Lo que esta tarjeta contaba ANTES: solo las cuotas que vencen ese día.
   *  Se conserva porque explica la diferencia entre los dos números. */
  cuotas_vencen_hoy: number | null
  total_ingresos: number | null
  total_gastos: number | null
  total_retiros: number | null
  total_ventas: number | null
  cantidad_ventas: number | null
  /** Parte de `total_ventas` que son ventas homologadas (script 057). Esa
   *  plata no salio de la caja de hoy: entro en el sistema anterior. */
  total_ventas_homologadas: number | null
  cantidad_ventas_homologadas: number | null
  fecha: string | null
}

type FinancialMovement = {
  id: number
  fechahorasol: string | null
  concepto: string | null
  valor: number | null
  observacion?: string | null
  tipo?: string | null
}

type SaleRow = {
  id: string
  created_at: string | null
  /** Capital prestado: es lo que vale la VENTA. */
  valor: number | null
  /** Total del contrato (capital + interes). No es el valor de la venta. */
  valor_a_pagar: number | null
  numero_cuotas: number | null
  clients?: {
    nombre_completo?: string | null
    apodo?: string | null
  } | null
}

/**
 * Un movimiento de la ruta = UN evento del libro `gestiones`.
 *
 * Antes esto era una fila de `payment_plan` ordenada por `fecha_pago_real`.
 * Esa columna ya no se escribe: el instante real de cada visita vive en
 * `gestiones.fecha_hora` y el día de negocio en `gestiones.fecha_gestion`.
 * Las coordenadas del cobrador también quedan en el evento.
 */
type GestionRow = {
  id: string
  loan_id: string
  tipo: TipoGestion
  monto: number | null
  fecha_gestion: string | null
  fecha_hora: string | null
  latitud: number | null
  longitud: number | null
  loans?: {
    id: string
    clients?: {
      nombre_completo?: string | null
      apodo?: string | null
      documento?: string | null
    } | null
  } | null
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
const formatCurrency = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString()}`

const formatHora = (iso: string | null) => horaColombia(iso)

// `estadoVisual` vivía acá y traducía el tipo de UN evento al vocabulario de
// la pantalla. Ya no hace falta: las filas son de un CLIENTE, no de un evento,
// y `colapsarPorCliente` decide el estado mirando el día completo.

/** Eventos que representan una visita del cobrador en el terreno. */
const ES_VISITA: TipoGestion[] = ["pago", "no_pago", "cancelacion", "abono_venta"]

const COLUMNAS_MOVIMIENTO =
  "id, loan_id, tipo, monto, fecha_gestion, fecha_hora, latitud, longitud, " +
  "loans:loans(id, clients:clients(nombre_completo, apodo, documento))"

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────
/** Quiénes ven TODAS las rutas. El resto ve las suyas y nada más. */
const ROLES_QUE_VEN_TODO = new Set(["admin", "administrador"])

interface AdminRouteMonitorProps {
  /**
   * Quién está mirando. Sin esto la pantalla mostraba todas las rutas a
   * cualquiera que tuviera el módulo habilitado — ver `rutasPermitidas`.
   */
  currentUser?: { id: number | string; rol?: string | null } | null
}

export function AdminRouteMonitor({ currentUser }: AdminRouteMonitorProps) {
  const { toast } = useToast()
  const [fecha, setFecha] = useState<string>(todayColombia())
  /**
   * Qué le toca mostrar a la tabla de clientes, o `null` si está cerrada.
   *
   * Se guarda el objeto entero y no un par de banderas: el efecto que carga
   * los datos depende de él, así que construirlo en línea en el JSX crearía
   * uno nuevo en cada render y la consulta entraría en bucle.
   */
  const [pagosDialog, setPagosDialog] = useState<FuentePagos | null>(null)
  const [rutas, setRutas] = useState<MonitoreoRuta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /**
   * LAS RUTAS QUE ESTA PERSONA PUEDE VER.
   *
   * `null` = todas (es admin). Un arreglo = solo esas.
   *
   * Esta pantalla se escribió para el admin, que ve la operación entera, y la
   * consulta salía sin filtro de ruta. Pero el módulo se puede habilitar por
   * usuario, y al hacerlo un cobrador de la 190 veía también la 151: su
   * recaudo, sus clientes y su cierre. Es el mismo agujero que el resto de la
   * app cierra con `.eq('ruta', ...)`, que acá faltaba.
   *
   * El admin NO se filtra por sus rutas asignadas a propósito: los dos admins
   * tienen rutas puestas (1,2 y 197) y filtrarlos los dejaría viendo dos
   * rutas de diez.
   */
  const [rutasPermitidas, setRutasPermitidas] = useState<number[] | null>(null)
  const [resolviendoPermiso, setResolviendoPermiso] = useState(true)

  useEffect(() => {
    let vigente = true
    const resolver = async () => {
      const rol = (currentUser?.rol ?? "").toLowerCase()
      if (ROLES_QUE_VEN_TODO.has(rol)) {
        if (vigente) { setRutasPermitidas(null); setResolviendoPermiso(false) }
        return
      }
      if (!currentUser?.id) {
        // Sin sesión identificable no se muestra nada. Antes se mostraba todo,
        // que es exactamente al revés de como conviene equivocarse.
        if (vigente) { setRutasPermitidas([]); setResolviendoPermiso(false) }
        return
      }
      try {
        const { data } = await createClient()
          .from("usuario_rutas")
          .select("ruta_id")
          .eq("usuario_id", currentUser.id)
        if (!vigente) return
        setRutasPermitidas(((data ?? []) as { ruta_id: number }[]).map((r) => r.ruta_id))
      } catch (e) {
        console.error("[v0] No se pudieron leer las rutas del usuario:", e)
        if (vigente) setRutasPermitidas([])
      } finally {
        if (vigente) setResolviendoPermiso(false)
      }
    }
    resolver()
    return () => { vigente = false }
  }, [currentUser?.id, currentUser?.rol])

  // Dialog state
  const [selectedRuta, setSelectedRuta] = useState<MonitoreoRuta | null>(null)
  const [detalle, setDetalle] = useState<GestionRow[]>([])
  const [loadingDetalle, setLoadingDetalle] = useState(false)
  // Token monotonico para descartar respuestas obsoletas / concurrentes.
  // Cada llamada a openDetalle incrementa el token; las respuestas con
  // token distinto al actual son ignoradas (evita race conditions).
  const fetchTokenRef = useRef(0)

  // Tracks which ruta_id is currently being approved (for per-card loading state)
  const [approvingRutaId, setApprovingRutaId] = useState<number | null>(null)

  // Financial details dialog state ("Detalle de Caja")
  const [cajaRuta, setCajaRuta] = useState<MonitoreoRuta | null>(null)
  const [cajaLoading, setCajaLoading] = useState(false)
  const [gastosList, setGastosList] = useState<FinancialMovement[]>([])
  const [ingresosList, setIngresosList] = useState<FinancialMovement[]>([])
  const [retirosList, setRetirosList] = useState<FinancialMovement[]>([])
  const [ventasList, setVentasList] = useState<SaleRow[]>([])

  // El ojito de Pendientes: quiénes son los que quedaron sin gestionar.
  const [cartera, setCartera] = useState<{ titulo: string; subtitulo: string; ids: string[] } | null>(null)
  const [cargandoCartera, setCargandoCartera] = useState<number | null>(null)

  // ── Load routes for the selected date ─────────────────────────────────────
  // SELECT sobre `vista_monitoreo_admin` por fecha Y POR LAS RUTAS QUE ESTA
  // PERSONA PUEDE VER. No hay RLS: si no se filtra acá, no lo filtra nadie.
  const fetchRutas = useCallback(async () => {
    // Todavía no se sabe qué puede ver: no se consulta. Un instante sin datos
    // es preferible a un instante mostrando rutas ajenas.
    if (resolviendoPermiso) return
    try {
      setLoading(true)
      setError(null)
      const supabase = createClient()

      let consulta = supabase
        .from("vista_monitoreo_admin")
        .select("*")
        .eq("fecha", fecha)
        .order("ruta_id", { ascending: true })

      // `null` = admin, ve todas. Un arreglo = solo esas. Vacío = ninguna, y
      // `.in()` con lista vacía devuelve cero filas, que es lo correcto.
      if (rutasPermitidas !== null) consulta = consulta.in("ruta_id", rutasPermitidas)

      const { data, error } = await consulta

      if (error) {
        console.error("[v0] vista_monitoreo_admin error:", error.message)
        setError(error.message)
        setRutas([])
        return
      }
      setRutas((data ?? []) as MonitoreoRuta[])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[v0] fetchRutas exception:", msg)
      setError(msg)
      setRutas([])
    } finally {
      setLoading(false)
    }
  }, [fecha, rutasPermitidas, resolviendoPermiso])

  useEffect(() => {
    fetchRutas()
  }, [fetchRutas])

  // ── Approve a closed route (aprobacion_admin → 'aprobado') ────────────────
  const handleAprobarCierre = useCallback(
    async (ruta: MonitoreoRuta) => {
      if (approvingRutaId !== null) return
      try {
        setApprovingRutaId(ruta.ruta_id)
        const supabase = createClient()
        const { error } = await supabase
          .from("rutas_diarias")
          .update({ aprobacion_admin: "aprobado" })
          .eq("ruta_id", ruta.ruta_id)
          .eq("fecha", fecha)

        if (error) {
          console.error("[v0] Error aprobando cierre:", error.message)
          return
        }

        // Optimistic local update + refresh
        setRutas((prev) =>
          prev.map((r) =>
            r.ruta_id === ruta.ruta_id ? { ...r, aprobacion_admin: "aprobado" } : r,
          ),
        )
        await fetchRutas()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[v0] handleAprobarCierre exception:", msg)
      } finally {
        setApprovingRutaId(null)
      }
    },
    [approvingRutaId, fecha, fetchRutas],
  )

  // ── Detalle de Caja: consultar gastos/ingresos/retiros/ventas ─────────────
  // Usa rango UTC equivalente al día de Colombia (UTC-5): [fechaT05:00Z, fecha+1T05:00Z)
  const fetchFinancialDetails = useCallback(
    async (ruta: MonitoreoRuta) => {
      try {
        setCajaLoading(true)
        setGastosList([])
        setIngresosList([])
        setRetirosList([])
        setVentasList([])
        const supabase = createClient()

        // Rango UTC del día en zona America/Bogota (UTC-5)
        const startUtc = `${fecha}T05:00:00Z`
        const nextDate = new Date(`${fecha}T00:00:00Z`)
        nextDate.setUTCDate(nextDate.getUTCDate() + 1)
        const nextYmd = nextDate.toISOString().slice(0, 10)
        const endUtc = `${nextYmd}T05:00:00Z`

        // Paralelo: gastos/ingresos/retiros + ventas
        const [gastosRes, ventasRes] = await Promise.all([
          supabase
            .from("gastosregistros")
            .select("id, fechahorasol, concepto, valor, observacion, tipo")
            .eq("ruta", ruta.ruta_id)
            .gte("fechahorasol", startUtc)
            .lt("fechahorasol", endUtc)
            .order("fechahorasol", { ascending: true }),
          supabase
            .from("loans")
            .select(
              "id, created_at, valor, valor_a_pagar, numero_cuotas, clients:clients(nombre_completo, apodo)",
            )
            .eq("ruta", ruta.ruta_id)
            .gte("created_at", startUtc)
            .lt("created_at", endUtc)
            .order("created_at", { ascending: true }),
        ])

        if (gastosRes.error) {
          console.error("[v0] Error fetching gastosregistros:", gastosRes.error.message)
        } else {
          const rows = (gastosRes.data ?? []) as FinancialMovement[]
          setGastosList(
            rows.filter((r) => (r.tipo ?? "").toLowerCase() === "gasto"),
          )
          setIngresosList(
            rows.filter((r) => (r.tipo ?? "").toLowerCase() === "ingreso"),
          )
          setRetirosList(
            rows.filter((r) => (r.tipo ?? "").toLowerCase() === "retiro"),
          )
        }

        if (ventasRes.error) {
          console.error("[v0] Error fetching ventas:", ventasRes.error.message)
        } else {
          setVentasList((ventasRes.data ?? []) as unknown as SaleRow[])
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[v0] fetchFinancialDetails exception:", msg)
      } finally {
        setCajaLoading(false)
      }
    },
    [fecha],
  )

  const openCajaDetalle = useCallback(
    (ruta: MonitoreoRuta) => {
      setCajaRuta(ruta)
      fetchFinancialDetails(ruta)
    },
    [fetchFinancialDetails],
  )

  const closeCajaDetalle = useCallback(() => {
    setCajaRuta(null)
    setGastosList([])
    setIngresosList([])
    setRetirosList([])
    setVentasList([])
  }, [])

  // ── Load detail for a specific route ──────────────────────────────────────
  // RLS eliminado: las queries filtran por `.eq('ruta', rutaId)` directamente.

  // Los movimientos del día salen del libro de eventos, no del cronograma:
  // `fecha_gestion` es el día de negocio al que aplica la visita y `fecha_hora`
  // el orden real del recorrido. Se excluye `homologacion` (historia migrada de
  // otro sistema) para cuadrar con los contadores de `vista_monitoreo_admin`.
  const fetchGestiones = useCallback(
    async (rutaId: number) => {
      const supabase = createClient()
      return supabase
        .from("gestiones")
        .select(COLUMNAS_MOVIMIENTO)
        .eq("ruta", rutaId)
        .eq("fecha_gestion", fecha)
        .eq("estado", "aplicada")
        .neq("origen", "homologacion")
        .order("fecha_hora", { ascending: true })
    },
    [fecha],
  )

  const openDetalle = useCallback(
    async (ruta: MonitoreoRuta) => {
      // Generamos un token nuevo para esta solicitud. Cualquier respuesta vieja
      // que llegue tarde sera descartada.
      const myToken = ++fetchTokenRef.current

      setSelectedRuta(ruta)
      setDetalle([])
      setLoadingDetalle(true)

      try {
        // Primer intento
        let { data, error } = await fetchGestiones(ruta.ruta_id)

        // Si el usuario cerro o cambio de ruta mientras tanto, descartar.
        if (fetchTokenRef.current !== myToken) return

        if (error) {
          console.error("[v0] gestiones detalle error:", error.message)
          setDetalle([])
          return
        }

        // Reintento silencioso si la primera respuesta vino vacia: el pool
        // pudo haber devuelto una conexion "fria" sin session vars. Una
        // segunda llamada normalmente sale por una conexion ya calentada.
        if (!data || data.length === 0) {
          // Pequena pausa para dar tiempo a que el RPC anterior haga commit
          await new Promise((r) => setTimeout(r, 120))
          if (fetchTokenRef.current !== myToken) return
          const retry = await fetchGestiones(ruta.ruta_id)
          if (fetchTokenRef.current !== myToken) return
          if (retry.error) {
            console.error("[v0] gestiones retry error:", retry.error.message)
          } else if (retry.data && retry.data.length > 0) {
            data = retry.data
          }
        }

        setDetalle((data ?? []) as unknown as GestionRow[])
      } catch (err) {
        if (fetchTokenRef.current !== myToken) return
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[v0] openDetalle exception:", msg)
        setDetalle([])
      } finally {
        if (fetchTokenRef.current === myToken) {
          setLoadingDetalle(false)
        }
      }
    },
    [fetchGestiones],
  )

  const closeDetalle = useCallback(() => {
    // Invalidar cualquier fetch en vuelo para que su respuesta no toque el estado.
    fetchTokenRef.current++
    setSelectedRuta(null)
    setDetalle([])
    setLoadingDetalle(false)
  }, [])

  // ── El ojito de Pendientes ────────────────────────────────────────────────
  // La lista sale de `cartera_del_dia`, que repite EL MISMO predicado que
  // cuenta la vista (script 060, paso 6 lo verifica). Se listan solo los que
  // quedaron sin gestionar: es exactamente el número sobre el que se hizo
  // clic, así que quien cuente las filas obtiene lo mismo que dice la tarjeta.
  const abrirCartera = useCallback(
    async (r: MonitoreoRuta) => {
      const dia = r.fecha ?? fecha
      setCargandoCartera(r.ruta_id)
      try {
        const { data, error } = await createClient().rpc("cartera_del_dia", {
          p_ruta_id: r.ruta_id,
          p_fecha: dia,
        })
        if (error) throw error
        const filas = (data ?? []) as { loan_id: string; gestionado: boolean }[]
        const pendientes = filas.filter((f) => !f.gestionado).map((f) => f.loan_id)
        setCartera({
          titulo: `Pendientes por visitar · Ruta #${r.ruta_id}`,
          subtitulo: `${pendientes.length} sin gestionar de ${filas.length} en cartera · ${dia}`,
          ids: pendientes,
        })
      } catch (err) {
        // Avisar SIN tocar `error`: esa bandera reemplaza toda la grilla por
        // una tarjeta de fallo, y que un ojito no abra no es motivo para
        // borrarle el monitoreo de la pantalla a quien lo está mirando.
        console.error("[v0] cartera_del_dia:", err)
        toast({
          title: "No se pudo cargar la lista de pendientes",
          description: err instanceof Error ? err.message : "Intenta de nuevo.",
          variant: "destructive",
        })
      } finally {
        setCargandoCartera(null)
      }
    },
    [fecha, toast],
  )

  // Reintenta el fetch para la ruta actualmente abierta (boton "Reintentar"
  // que aparece cuando no hay datos GPS).
  const retryDetalle = useCallback(() => {
    if (selectedRuta) {
      openDetalle(selectedRuta)
    }
  }, [openDetalle, selectedRuta])

  /**
   * UNA FILA POR CLIENTE, no una por papel.
   *
   * `detalle` es el libro crudo del dia. Una tarde de correcciones de
   * secretaria deja diez renglones del mismo cliente, ocho de ellos en cero.
   * `colapsarPorCliente` aplica la MISMA regla que `resumen_diario_v2`
   * (script 070), asi que esta lista y el contador de la tarjeta no pueden
   * discrepar: si la vista dice 13 pagos, aca hay 13 filas.
   *
   * Se le pasa `tieneGps` para que, cuando un cliente tenga varios eventos,
   * la fila se quede con la hora y las coordenadas de la VISITA real y no
   * con las de un ajuste de escritorio posterior.
   */
  const detalleColapsado = useMemo(
    () =>
      colapsarPorCliente(detalle, {
        tieneGps: (e) =>
          typeof e.latitud === "number" &&
          typeof e.longitud === "number" &&
          !Number.isNaN(e.latitud) &&
          !Number.isNaN(e.longitud),
      }),
    [detalle],
  )

  // ── Build ordered list of map points (with valid GPS) ─────────────────────
  /**
   * Cuantas de las gestiones del dia SON una visita.
   *
   * Se separa de `mapPoints` para poder distinguir dos situaciones que antes
   * daban el mismo mensaje: que la ruta no haya trabajado todavia, y que haya
   * trabajado sin GPS. La primera es normal; la segunda hay que mirarla.
   *
   * Cuenta SOLO pago, no_pago y cancelacion. No usa `ES_VISITA`, que ademas
   * incluye `abono_venta`: ese se registra al CREAR la venta, desde el
   * formulario, y nunca trae coordenadas — contarlo haria que una ruta con un
   * abono y nada mas avisara de un problema de GPS que no existe.
   *
   * Las reversas y los ajustes tampoco cuentan, por lo mismo: se registran
   * desde un escritorio corrigiendo algo que ya paso.
   *
   * Ahora cuenta CLIENTES visitados, no eventos: si no, un cobrador que
   * corrige el monto tres veces inflaba el aviso de GPS igual que inflaba
   * el recaudo.
   */
  const TIPOS_CON_GPS: TipoGestion[] = ["pago", "no_pago", "cancelacion"]
  const visitasDelDia = useMemo(
    () =>
      detalleColapsado.filter((r) => TIPOS_CON_GPS.includes(r.representante.tipo))
        .length,
    [detalleColapsado],
  )

  const mapPoints: MapPoint[] = useMemo(() => {
    return detalleColapsado
      .filter((r) => {
        const e = r.representante
        return (
          typeof e.latitud === "number" &&
          typeof e.longitud === "number" &&
          !Number.isNaN(e.latitud) &&
          !Number.isNaN(e.longitud) &&
          ES_VISITA.includes(e.tipo)
        )
      })
      .map((r, idx) => ({
        id: r.representante.id,
        lat: r.representante.latitud as number,
        lng: r.representante.longitud as number,
        estado: r.estado,
        cliente:
          r.representante.loans?.clients?.apodo ||
          r.representante.loans?.clients?.nombre_completo ||
          "Cliente",
        // El NETO del cliente ese dia, no el monto de un evento suelto.
        monto: r.neto,
        hora: formatHora(r.representante.fecha_hora),
        orden: idx + 1,
      }))
  }, [detalleColapsado])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-xl md:text-2xl">
                <Route className="h-5 w-5 text-brand" />
                Monitoreo de Rutas
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Estado de cada ruta, recaudo y seguimiento en mapa
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="fecha-monitoreo" className="text-xs text-muted-foreground">
                  Fecha
                </Label>
                <div className="relative">
                  <CalendarIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="fecha-monitoreo"
                    type="date"
                    value={fecha}
                    onChange={(e) => setFecha(e.target.value)}
                    className="h-9 pl-8"
                  />
                </div>
              </div>
              <Button
                variant="outline"
                className="h-9 gap-1.5"
                onClick={fetchRutas}
                disabled={loading}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Actualizar
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Route cards grid */}
      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-5 w-24 rounded bg-muted" />
                <div className="h-4 w-16 rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="h-8 w-32 rounded bg-muted" />
                <div className="mt-3 h-4 w-full rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <XCircle className="h-10 w-10 text-destructive" />
            <p className="font-semibold">No se pudo cargar el monitoreo</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchRutas}>
              Reintentar
            </Button>
          </CardContent>
        </Card>
      ) : rutas.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <CalendarIcon className="h-10 w-10 text-muted-foreground" />
            <p className="font-semibold">Sin rutas para esta fecha</p>
            <p className="text-sm text-muted-foreground">
              No hay actividad registrada en {fecha}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-border/60 shadow-steel">
          <div className="divide-y divide-border">
            {rutas.map((r) => {
              const isAbierta = (r.estado_ruta ?? "").toLowerCase() === "abierta"
              const isCerrada = (r.estado_ruta ?? "").toLowerCase() === "cerrada"

              /**
               * ESTADO DE LA JORNADA — tres casos, no dos.
               *
               * Antes una jornada 'abierta' decía "Abierta" sin mirar la
               * fecha, así que un día pasado en el que la ruta NUNCA cerró
               * caja se leía igual que una ruta trabajando ahora mismo. Son
               * cosas distintas: una está en curso y la otra terminó mal.
               *
               * La auditoría del 26/08 vive de esta diferencia: las rutas 1 y
               * 151 aparecían "Abiertas" cuando lo que pasó es que se
               * quedaron sin cerrar.
               */
              const esHoy = fecha === todayColombia()
              const jornada = isCerrada
                ? { texto: "Cerrada", clase: "border-0 bg-success text-success-foreground" }
                : isAbierta
                  ? esHoy
                    ? { texto: "Abierta", clase: "border-0 bg-info text-info-foreground" }
                    : { texto: "Sin cierre", clase: "border-0 bg-warning text-warning-foreground" }
                  : { texto: "Sin jornada", clase: "border-0 bg-muted text-muted-foreground" }
              const aprobacion = (r.aprobacion_admin ?? "").toLowerCase()
              const pendienteAprobacion = isCerrada && aprobacion === "pendiente"
              const aprobado = isCerrada && aprobacion === "aprobado"
              const isApproving = approvingRutaId === r.ruta_id
              const pagos = r.pagos_exitosos ?? 0
              const sinPago = r.visitas_sin_pago ?? 0
              const pendientes = r.pendientes_por_visitar ?? 0
              const carteraActiva = r.cartera_activa ?? 0
              const vencenHoy = r.cuotas_vencen_hoy ?? 0
              const cargandoEste = cargandoCartera === r.ruta_id

              return (
                <div
                  key={`${r.ruta_id}-${r.fecha ?? ""}`}
                  className={`group relative flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-muted/30 lg:flex-row lg:items-center lg:gap-4 lg:py-4 ${
                    pendienteAprobacion ? "bg-warning/5" : ""
                  }`}
                >
                  {/* Indicador lateral para cierre pendiente */}
                  {pendienteAprobacion && (
                    <span className="absolute inset-y-0 left-0 w-1 bg-warning" aria-hidden />
                  )}

                  {/* Ruta + Estado */}
                  <div className="flex items-center gap-3 lg:w-[180px] lg:shrink-0">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand/10 shrink-0">
                      <Route className="h-5 w-5 text-brand" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Ruta
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xl font-bold leading-none text-brand">
                          #{r.ruta_id}
                        </span>
                        <Badge
                          className={jornada.clase}
                          title={
                            jornada.texto === "Sin cierre"
                              ? "La jornada se abrió y nunca se cerró la caja"
                              : jornada.texto === "Sin jornada"
                                ? "La ruta no abrió jornada ese día"
                                : undefined
                          }
                        >
                          {jornada.texto}
                        </Badge>
                      </div>
                      {pendienteAprobacion && (
                        <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-warning">
                          <AlertTriangle className="h-3 w-3" />
                          Pendiente aprobación
                        </span>
                      )}
                      {aprobado && (
                        <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-success">
                          <ShieldCheck className="h-3 w-3" />
                          Cierre auditado
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Recaudo — EL DEL COBRADOR.
                      Antes acá iba `total_recaudado`, que mezcla la plata de
                      la calle con las correcciones que secretaría escribe ese
                      día sobre cuotas de OTROS días. Por eso la 151 marcaba
                      1.103.500 un día en que el cobrador recaudó 341.500.
                      Arriba va lo que él responde; los ajustes se muestran
                      debajo, en pequeño, para que no desaparezcan. */}
                  <div className="flex flex-col lg:w-[150px] lg:shrink-0">
                    <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <Banknote className="h-3 w-3" />
                      Recaudo
                    </span>
                    <span className="text-lg font-bold tabular-nums text-foreground">
                      {formatCurrency(r.recaudo_campo)}
                    </span>
                    {Number(r.recaudo_ajuste) !== 0 && (
                      <span
                        className="text-[11px] tabular-nums text-muted-foreground"
                        title="Correcciones de secretaría sobre cuotas de otros días. No es plata que haya entrado hoy por la calle."
                      >
                        {Number(r.recaudo_ajuste) > 0 ? "+" : "−"}
                        {formatCurrency(Math.abs(Number(r.recaudo_ajuste)))} en ajustes
                      </span>
                    )}
                  </div>

                  {/* Gestión: Pagos / Sin Pago / Pendientes */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 lg:flex-1 lg:min-w-0">
                    {/* Los dos contadores abren la MISMA tabla que el ojito
                        de Pagos en el Resumen del Día: nombre con apodo, la
                        plata, las cuotas, el saldo y el ojo de historial. Se
                        pidió "poder ver quiénes fueron esos pagos y no pagos"
                        y esa tabla ya existía. */}
                    <button
                      type="button"
                      onClick={() =>
                        setPagosDialog({
                          tipo: "dia", rutaId: r.ruta_id, fecha: r.fecha ?? fecha,
                          modo: "pagos", titulo: `Pagos · ruta ${r.ruta_id}`,
                        })
                      }
                      disabled={pagos === 0}
                      title={pagos === 0 ? "Sin pagos ese día" : `Ver los ${pagos} clientes que pagaron`}
                      className="flex items-center gap-1.5 rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-success/10 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      <span className="text-sm font-bold tabular-nums text-foreground">{pagos}</span>
                      <span className="text-[11px] text-muted-foreground">Pagos</span>
                      {/* El ojito. Va DENTRO del boton y no al lado como en el
                          Resumen: aca el contador entero ya es el area que se
                          toca, y meter un boton dentro de otro es HTML
                          invalido. Se ve igual y el dedo tiene mas sitio. */}
                      <Eye
                        className={`h-3 w-3 shrink-0 ${
                          pagos === 0 ? "text-muted-foreground/30" : "text-muted-foreground"
                        }`}
                        aria-hidden
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPagosDialog({
                          tipo: "dia", rutaId: r.ruta_id, fecha: r.fecha ?? fecha,
                          modo: "no_pagos", titulo: `No pagos · ruta ${r.ruta_id}`,
                        })
                      }
                      disabled={sinPago === 0}
                      title={sinPago === 0 ? "Sin no pagos ese día" : `Ver los ${sinPago} clientes visitados que no pagaron`}
                      className="flex items-center gap-1.5 rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-destructive/10 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <XCircle className="h-4 w-4 text-destructive" />
                      <span className="text-sm font-bold tabular-nums text-foreground">{sinPago}</span>
                      <span className="text-[11px] text-muted-foreground">Sin Pago</span>
                      <Eye
                        className={`h-3 w-3 shrink-0 ${
                          sinPago === 0 ? "text-muted-foreground/30" : "text-muted-foreground"
                        }`}
                        aria-hidden
                      />
                    </button>
                    {/* Pendientes = CARTERA sin gestionar, no solo las cuotas
                        que vencen hoy. El denominador va al lado porque "48
                        pendientes" a secas no dice si la ruta va atrasada o si
                        simplemente tiene 300 clientes. */}
                    <button
                      type="button"
                      onClick={() => void abrirCartera(r)}
                      disabled={cargandoEste || pendientes === 0}
                      title={
                        pendientes === 0
                          ? "Sin pendientes"
                          : `Ver los ${pendientes} clientes sin gestionar (${vencenHoy} con cuota que vence hoy)`
                      }
                      className="flex items-center gap-1.5 rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-brand/10 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      {cargandoEste ? (
                        <Loader2 className="h-4 w-4 animate-spin text-brand" />
                      ) : (
                        <Clock className="h-4 w-4 text-brand" />
                      )}
                      <span className="text-sm font-bold tabular-nums text-foreground">
                        {pendientes}
                        {carteraActiva > 0 && (
                          <span className="font-normal text-muted-foreground"> / {carteraActiva}</span>
                        )}
                      </span>
                      <span className="text-[11px] text-muted-foreground">Pendientes</span>
                      {pendientes > 0 && <Eye className="h-3.5 w-3.5 text-brand/70" />}
                    </button>
                    {vencenHoy > 0 && (
                      <span
                        className="text-[11px] text-muted-foreground"
                        title="De la cartera, cuántas cuotas tienen vencimiento justo hoy"
                      >
                        {vencenHoy} vencen hoy
                      </span>
                    )}
                  </div>

                  {/* Resumen Financiero */}
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px] lg:grid-cols-4 lg:flex-1 lg:min-w-[280px]">
                    <div className="flex items-center justify-between gap-2 lg:flex-col lg:items-start lg:justify-center lg:gap-0">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <TrendingUp className="h-3 w-3 text-success" />
                        Ingresos
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatCurrency(r.total_ingresos)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 lg:flex-col lg:items-start lg:justify-center lg:gap-0">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Receipt className="h-3 w-3 text-destructive" />
                        Gastos
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatCurrency(r.total_gastos)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 lg:flex-col lg:items-start lg:justify-center lg:gap-0">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Wallet className="h-3 w-3 text-brand-secondary" />
                        Retiros
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatCurrency(r.total_retiros)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 lg:flex-col lg:items-start lg:justify-center lg:gap-0">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <ShoppingCart className="h-3 w-3 text-brand" />
                        Ventas
                      </span>
                      <span
                        className="inline-flex items-center gap-1 font-semibold tabular-nums text-foreground"
                        title={
                          (r.cantidad_ventas_homologadas ?? 0) > 0
                            ? `Incluye ${r.cantidad_ventas_homologadas} homologada(s) por ${formatCurrency(r.total_ventas_homologadas)}: esa plata no salio de la caja de hoy.`
                            : undefined
                        }
                      >
                        {formatCurrency(r.total_ventas)}
                        {(r.cantidad_ventas ?? 0) > 0 && (
                          <span className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-brand/10 px-1 text-[9px] font-bold text-brand">
                            {r.cantidad_ventas}
                          </span>
                        )}
                        {/* Las homologadas suman al total de ventas pero NO
                            salieron de la caja: se marcan para que la
                            diferencia con el efectivo se pueda explicar. */}
                        {(r.cantidad_ventas_homologadas ?? 0) > 0 && (
                          <span className="rounded-full bg-violet-100 px-1 text-[9px] font-bold text-violet-700">
                            {r.cantidad_ventas_homologadas} hom.
                          </span>
                        )}
                      </span>
                    </div>
                  </div>

                  {/* Acciones */}
                  <div className="flex items-center gap-2 lg:shrink-0">
                    {pendienteAprobacion && (
                      <Button
                        size="sm"
                        className="gap-1.5 bg-brand-secondary text-brand-secondary-foreground hover:bg-brand-secondary/90"
                        onClick={() => handleAprobarCierre(r)}
                        disabled={isApproving}
                      >
                        {isApproving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5" />
                        )}
                        <span className="hidden sm:inline">
                          {isApproving ? "Aprobando..." : "Aprobar Cierre"}
                        </span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => openCajaDetalle(r)}
                    >
                      <ReceiptText className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Detalle de Caja</span>
                    </Button>
                    <Button
                      size="sm"
                      variant={pendienteAprobacion ? "outline" : "default"}
                      className="gap-1.5"
                      onClick={() => openDetalle(r)}
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Ver Mapa</span>
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Detail Dialog */}
      <Dialog open={selectedRuta !== null} onOpenChange={(open) => !open && closeDetalle()}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Route className="h-5 w-5 text-brand" />
              Ruta #{selectedRuta?.ruta_id} · {fecha}
            </DialogTitle>
            <DialogDescription>
              Seguimiento cronológico del vendedor, pagos y no pagos registrados.
            </DialogDescription>
          </DialogHeader>

          {loadingDetalle ? (
            <div className="flex h-[420px] items-center justify-center rounded-xl bg-muted/40 shadow-steel">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : mapPoints.length > 0 ? (
            <AdminRouteMonitorMap points={mapPoints} />
          ) : (
            /* Dos situaciones distintas que antes decian lo mismo.
               "Sin datos GPS disponibles" sobre una ruta que simplemente no ha
               salido a cobrar se lee como una falla del sistema, y asi lo
               reportan los usuarios. */
            <div className="flex h-[240px] w-full flex-col items-center justify-center gap-2 rounded-xl bg-muted/30 px-4 text-center">
              <MapPinOff className="h-10 w-10 text-muted-foreground" />
              <p className="font-semibold">
                {visitasDelDia === 0 ? "Todavía no hay visitas registradas" : "Visitas sin ubicación"}
              </p>
              <p className="text-sm text-muted-foreground">
                {visitasDelDia === 0
                  ? detalle.length > 0
                    ? "La ruta tiene movimientos de este día, pero ninguno es una visita: las reversas y los ajustes se registran desde un escritorio y no llevan ubicación."
                    : "La jornada está abierta pero no se ha registrado ningún pago ni no pago. El mapa se dibuja con las visitas del día."
                  : `Las ${visitasDelDia} visitas de este día se registraron sin coordenadas. Eso no debería pasar: revisa el GPS del dispositivo del cobrador.`}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 gap-1.5"
                onClick={retryDetalle}
                disabled={loadingDetalle}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingDetalle ? "animate-spin" : ""}`} />
                Reintentar
              </Button>
            </div>
          )}

          {/* Movements table */}
          <div className="mt-4 overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">#</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Monto</TableHead>
                  <TableHead>Hora</TableHead>
                  <TableHead className="text-center">GPS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detalleColapsado.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                      Sin movimientos registrados
                    </TableCell>
                  </TableRow>
                ) : (
                  detalleColapsado.map((fila, idx) => {
                    const r = fila.representante
                    const cliente =
                      r.loans?.clients?.apodo ||
                      r.loans?.clients?.nombre_completo ||
                      "Cliente"
                    const hasGps =
                      typeof r.latitud === "number" && typeof r.longitud === "number"
                    const estado = fila.estado
                    const color =
                      estado === "pagado"
                        ? "bg-success text-success-foreground"
                        : "bg-destructive text-destructive-foreground"
                    // Cuantos papeles hubo detras de esta fila. Se dice, no se
                    // esconde: es la pista de que ese cliente se corrigio.
                    const correcciones = fila.eventos.length
                    return (
                      <TableRow key={fila.loanId}>
                        <TableCell className="font-medium">{idx + 1}</TableCell>
                        <TableCell className="font-medium">
                          {cliente}
                          {correcciones > 1 && (
                            <span
                              className="ml-1 text-[11px] font-normal text-muted-foreground"
                              title={`${correcciones} movimientos en el libro, ya netos`}
                            >
                              ({correcciones} mov.)
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge className={`${color} border-0`}>{estado}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {formatCurrency(fila.neto)}
                        </TableCell>
                        <TableCell>{formatHora(r.fecha_hora) || "—"}</TableCell>
                        <TableCell className="text-center">
                          {hasGps ? (
                            <a
                              href={`https://www.google.com/maps?q=${r.latitud},${r.longitud}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Ubicar en Google Maps"
                            >
                              <MapPin className="mx-auto h-4 w-4 text-success hover:text-success/70" />
                            </a>
                          ) : (
                            <MapPinOff className="mx-auto h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Caja detalle dialog (Gastos / Ingresos / Retiros / Ventas) */}
      <Dialog open={cajaRuta !== null} onOpenChange={(open) => !open && closeCajaDetalle()}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ReceiptText className="h-5 w-5 text-brand" />
              Detalle de Caja · Ruta #{cajaRuta?.ruta_id} · {fecha}
            </DialogTitle>
            <DialogDescription>
              Desglose de los movimientos financieros registrados durante la jornada.
            </DialogDescription>
          </DialogHeader>

          {cajaLoading ? (
            <div className="flex h-[280px] items-center justify-center rounded-xl bg-muted/30 shadow-steel">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Tabs defaultValue="gastos" className="mt-2">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="gastos" className="gap-1.5">
                  <Receipt className="h-3.5 w-3.5" />
                  <span>Gastos</span>
                </TabsTrigger>
                <TabsTrigger value="ingresos" className="gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5" />
                  <span>Ingresos</span>
                </TabsTrigger>
                <TabsTrigger value="retiros" className="gap-1.5">
                  <Wallet className="h-3.5 w-3.5" />
                  <span>Retiros</span>
                </TabsTrigger>
                <TabsTrigger value="ventas" className="gap-1.5">
                  <ShoppingCart className="h-3.5 w-3.5" />
                  <span>Ventas</span>
                </TabsTrigger>
              </TabsList>

              {/* Gastos */}
              <TabsContent value="gastos" className="mt-3">
                <FinancialTable
                  rows={gastosList}
                  emptyMessage="No se registraron gastos en este día"
                  showObservacion
                />
              </TabsContent>

              {/* Ingresos */}
              <TabsContent value="ingresos" className="mt-3">
                <FinancialTable
                  rows={ingresosList}
                  emptyMessage="No se registraron ingresos en este día"
                />
              </TabsContent>

              {/* Retiros */}
              <TabsContent value="retiros" className="mt-3">
                <FinancialTable
                  rows={retirosList}
                  emptyMessage="No se registraron retiros en este día"
                />
              </TabsContent>

              {/* Ventas */}
              <TabsContent value="ventas" className="mt-3">
                <SalesTable rows={ventasList} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* Quiénes son los pendientes por visitar */}
      <DetalleClientesDialog
        open={cartera !== null}
        onOpenChange={(v) => { if (!v) setCartera(null) }}
        titulo={cartera?.titulo ?? ""}
        subtitulo={cartera?.subtitulo}
        loanIds={cartera?.ids ?? []}
      />

      {/* Quiénes fueron los pagos y los no pagos de esa ruta ese día. Es el
          mismo diálogo del Resumen del Día, con la misma tabla. */}
      <PagosDelDiaDialog
        open={pagosDialog !== null}
        onOpenChange={(v) => { if (!v) setPagosDialog(null) }}
        fuente={pagosDialog}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Compact financial tables (used inside Detalle de Caja)
// ────────────────────────────────────────────────────────────────────────────
function FinancialTable({
  rows,
  emptyMessage,
  showObservacion = false,
}: {
  rows: FinancialMovement[]
  emptyMessage: string
  showObservacion?: boolean
}) {
  const total = rows.reduce((acc, r) => acc + (Number(r.valor) || 0), 0)

  if (rows.length === 0) {
    return (
      <div className="flex h-[200px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-muted/20 text-center">
        <Receipt className="h-7 w-7 text-muted-foreground" />
        <p className="text-sm font-medium text-muted-foreground">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Hora</TableHead>
            <TableHead>Concepto</TableHead>
            {showObservacion && <TableHead>Observación</TableHead>}
            <TableHead className="text-right">Valor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="text-xs tabular-nums text-muted-foreground">
                {formatHora(r.fechahorasol) || "—"}
              </TableCell>
              <TableCell className="text-sm font-medium">{r.concepto || "—"}</TableCell>
              {showObservacion && (
                <TableCell className="text-xs text-muted-foreground">
                  {r.observacion || "—"}
                </TableCell>
              )}
              <TableCell className="text-right text-sm font-semibold tabular-nums">
                {formatCurrency(r.valor)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="bg-muted/50">
            <TableCell
              colSpan={showObservacion ? 3 : 2}
              className="text-right text-xs font-bold uppercase tracking-wider text-muted-foreground"
            >
              Total de la sección
            </TableCell>
            <TableCell className="text-right text-base font-bold tabular-nums text-foreground">
              {formatCurrency(total)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  )
}

function SalesTable({ rows }: { rows: SaleRow[] }) {
  // El valor de una venta es el CAPITAL prestado. Antes se sumaba
  // `valor_a_pagar` (capital + interes), asi que este listado no cuadraba con
  // el total de ventas de la tarjeta de arriba ni con "Ventas del dia".
  const total = rows.reduce((acc, r) => acc + (Number(r.valor) || 0), 0)

  if (rows.length === 0) {
    return (
      <div className="flex h-[200px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-muted/20 text-center">
        <ShoppingCart className="h-7 w-7 text-muted-foreground" />
        <p className="text-sm font-medium text-muted-foreground">
          No se registraron ventas en este día
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Hora</TableHead>
            <TableHead>Cliente</TableHead>
            <TableHead className="text-right">Valor Venta</TableHead>
            <TableHead className="text-center">Cuotas</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const cliente = r.clients?.apodo || r.clients?.nombre_completo || "Cliente"
            return (
              <TableRow key={r.id}>
                <TableCell className="text-xs tabular-nums text-muted-foreground">
                  {formatHora(r.created_at) || "—"}
                </TableCell>
                <TableCell className="text-sm font-medium">{cliente}</TableCell>
                <TableCell className="text-right text-sm font-semibold tabular-nums">
                  {formatCurrency(r.valor)}
                </TableCell>
                <TableCell className="text-center text-xs font-bold tabular-nums text-brand">
                  {r.numero_cuotas ?? "—"}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
        <TableFooter>
          <TableRow className="bg-muted/50">
            <TableCell
              colSpan={2}
              className="text-right text-xs font-bold uppercase tracking-wider text-muted-foreground"
            >
              Total ventas ({rows.length})
            </TableCell>
            <TableCell className="text-right text-base font-bold tabular-nums text-foreground">
              {formatCurrency(total)}
            </TableCell>
            <TableCell />
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  )
}
