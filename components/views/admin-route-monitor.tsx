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
} from "lucide-react"
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
  pagos_exitosos: number | null
  visitas_sin_pago: number | null
  pendientes_por_visitar: number | null
  total_ingresos: number | null
  total_gastos: number | null
  total_retiros: number | null
  total_ventas: number | null
  cantidad_ventas: number | null
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
  valor_a_pagar: number | null
  numero_cuotas: number | null
  clients?: {
    nombre_completo?: string | null
    apodo?: string | null
  } | null
}

type PaymentPlanRow = {
  id: string
  loan_id: string
  estado: string
  monto_pagado: number | null
  fecha_pago: string | null
  fecha_pago_real: string | null
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
const getTodayColombia = () => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return fmt.format(new Date()) // YYYY-MM-DD
}

const formatCurrency = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString()}`

const formatHora = (iso: string | null) => {
  if (!iso) return ""
  try {
    const d = new Date(iso)
    return new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d)
  } catch {
    return ""
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────
export function AdminRouteMonitor() {
  const [fecha, setFecha] = useState<string>(getTodayColombia())
  const [rutas, setRutas] = useState<MonitoreoRuta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Dialog state
  const [selectedRuta, setSelectedRuta] = useState<MonitoreoRuta | null>(null)
  const [detalle, setDetalle] = useState<PaymentPlanRow[]>([])
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

  // ── Load routes for the selected date ─────────────────────────────────────
  // SELECT directo sobre `vista_monitoreo_admin` filtrado por fecha. La vista
  // es de administracion (los admins ven TODAS las rutas en la fecha, sin
  // filtro por ruta_id). RLS eliminado.
  const fetchRutas = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const supabase = createClient()

      const { data, error } = await supabase
        .from("vista_monitoreo_admin")
        .select("*")
        .eq("fecha", fecha)
        .order("ruta_id", { ascending: true })

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
  }, [fecha])

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
              "id, created_at, valor_a_pagar, numero_cuotas, clients:clients(nombre_completo, apodo)",
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

  const fetchPaymentPlan = useCallback(
    async (rutaId: number) => {
      const supabase = createClient()
      return supabase
        .from("payment_plan")
        .select(
          "id, loan_id, estado, monto_pagado, fecha_pago, fecha_pago_real, latitud, longitud, loans:loans(id, clients:clients(nombre_completo, apodo, documento))",
        )
        .eq("ruta", rutaId)
        .eq("fecha_pago", fecha)
        .order("fecha_pago_real", { ascending: true, nullsFirst: false })
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
        let { data, error } = await fetchPaymentPlan(ruta.ruta_id)

        // Si el usuario cerro o cambio de ruta mientras tanto, descartar.
        if (fetchTokenRef.current !== myToken) return

        if (error) {
          console.error("[v0] payment_plan detalle error:", error.message)
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
          const retry = await fetchPaymentPlan(ruta.ruta_id)
          if (fetchTokenRef.current !== myToken) return
          if (retry.error) {
            console.error("[v0] payment_plan retry error:", retry.error.message)
          } else if (retry.data && retry.data.length > 0) {
            data = retry.data
          }
        }

        setDetalle((data ?? []) as unknown as PaymentPlanRow[])
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
    [fetchPaymentPlan],
  )

  const closeDetalle = useCallback(() => {
    // Invalidar cualquier fetch en vuelo para que su respuesta no toque el estado.
    fetchTokenRef.current++
    setSelectedRuta(null)
    setDetalle([])
    setLoadingDetalle(false)
  }, [])

  // Reintenta el fetch para la ruta actualmente abierta (boton "Reintentar"
  // que aparece cuando no hay datos GPS).
  const retryDetalle = useCallback(() => {
    if (selectedRuta) {
      openDetalle(selectedRuta)
    }
  }, [openDetalle, selectedRuta])

  // ── Build ordered list of map points (with valid GPS) ─────────────────────
  const mapPoints: MapPoint[] = useMemo(() => {
    return detalle
      .filter(
        (r) =>
          typeof r.latitud === "number" &&
          typeof r.longitud === "number" &&
          !Number.isNaN(r.latitud) &&
          !Number.isNaN(r.longitud) &&
          (r.estado === "pagado" || r.estado === "no_pago" || r.estado === "parcial" || r.estado === "cancelada"),
      )
      .sort((a, b) => {
        const aT = a.fecha_pago_real ? new Date(a.fecha_pago_real).getTime() : 0
        const bT = b.fecha_pago_real ? new Date(b.fecha_pago_real).getTime() : 0
        return aT - bT
      })
      .map((r, idx) => ({
        id: r.id,
        lat: r.latitud as number,
        lng: r.longitud as number,
        estado: r.estado,
        cliente:
          r.loans?.clients?.apodo || r.loans?.clients?.nombre_completo || "Cliente",
        monto: Number(r.monto_pagado) || 0,
        hora: formatHora(r.fecha_pago_real),
        orden: idx + 1,
      }))
  }, [detalle])

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
              const aprobacion = (r.aprobacion_admin ?? "").toLowerCase()
              const pendienteAprobacion = isCerrada && aprobacion === "pendiente"
              const aprobado = isCerrada && aprobacion === "aprobado"
              const isApproving = approvingRutaId === r.ruta_id
              const pagos = r.pagos_exitosos ?? 0
              const sinPago = r.visitas_sin_pago ?? 0
              const pendientes = r.pendientes_por_visitar ?? 0

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
                          className={
                            isAbierta
                              ? "border-0 bg-success text-success-foreground"
                              : "border-0 bg-muted text-muted-foreground"
                          }
                        >
                          {isAbierta ? "Abierta" : r.estado_ruta ? "Cerrada" : "Sin datos"}
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

                  {/* Recaudo */}
                  <div className="flex flex-col lg:w-[150px] lg:shrink-0">
                    <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <Banknote className="h-3 w-3" />
                      Recaudo
                    </span>
                    <span className="text-lg font-bold tabular-nums text-foreground">
                      {formatCurrency(r.total_recaudado)}
                    </span>
                  </div>

                  {/* Gestión: Pagos / Sin Pago / Pendientes */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 lg:flex-1 lg:min-w-0">
                    <div className="flex items-center gap-1.5" title="Pagos">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      <span className="text-sm font-bold tabular-nums text-foreground">{pagos}</span>
                      <span className="text-[11px] text-muted-foreground">Pagos</span>
                    </div>
                    <div className="flex items-center gap-1.5" title="Sin Pago">
                      <XCircle className="h-4 w-4 text-destructive" />
                      <span className="text-sm font-bold tabular-nums text-foreground">{sinPago}</span>
                      <span className="text-[11px] text-muted-foreground">Sin Pago</span>
                    </div>
                    <div className="flex items-center gap-1.5" title="Pendientes">
                      <Clock className="h-4 w-4 text-brand" />
                      <span className="text-sm font-bold tabular-nums text-foreground">{pendientes}</span>
                      <span className="text-[11px] text-muted-foreground">Pendientes</span>
                    </div>
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
                      <span className="inline-flex items-center gap-1 font-semibold tabular-nums text-foreground">
                        {formatCurrency(r.total_ventas)}
                        {(r.cantidad_ventas ?? 0) > 0 && (
                          <span className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-brand/10 px-1 text-[9px] font-bold text-brand">
                            {r.cantidad_ventas}
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
            <div className="flex h-[240px] w-full flex-col items-center justify-center gap-2 rounded-xl bg-muted/30 px-4 text-center">
              <MapPinOff className="h-10 w-10 text-muted-foreground" />
              <p className="font-semibold">Sin datos GPS disponibles</p>
              <p className="text-sm text-muted-foreground">
                No se registraron coordenadas para los movimientos de esta ruta o
                la consulta no devolvio resultados.
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
                {detalle.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                      Sin movimientos registrados
                    </TableCell>
                  </TableRow>
                ) : (
                  detalle.map((r, idx) => {
                    const cliente =
                      r.loans?.clients?.apodo ||
                      r.loans?.clients?.nombre_completo ||
                      "Cliente"
                    const hasGps =
                      typeof r.latitud === "number" && typeof r.longitud === "number"
                    const color =
                      r.estado === "pagado" || r.estado === "parcial" || r.estado === "cancelada"
                        ? "bg-success text-success-foreground"
                        : r.estado === "no_pago"
                          ? "bg-destructive text-destructive-foreground"
                          : "bg-muted text-muted-foreground"
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{idx + 1}</TableCell>
                        <TableCell className="font-medium">{cliente}</TableCell>
                        <TableCell>
                          <Badge className={`${color} border-0`}>{r.estado}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {formatCurrency(r.monto_pagado)}
                        </TableCell>
                        <TableCell>{formatHora(r.fecha_pago_real) || "—"}</TableCell>
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
  const total = rows.reduce((acc, r) => acc + (Number(r.valor_a_pagar) || 0), 0)

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
                  {formatCurrency(r.valor_a_pagar)}
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
