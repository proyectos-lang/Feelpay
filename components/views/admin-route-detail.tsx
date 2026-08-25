"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Loader2, RefreshCw, AlertCircle,
  CheckCircle2, XCircle, ShoppingCart,
  Receipt, TrendingUp, ArrowDownCircle, Clock, User,
} from "lucide-react"
import {
  todayColombia, horaColombia, fmtMoneda, etiquetaFrecuencia, colapsarPorCliente,
  type TipoGestion,
} from "@/lib/gestion-core"

// ── Types ─────────────────────────────────────────────────────────────────────

type RutaInfo = { id: number; nombre: string; ciudad: string | null }

/**
 * Una fila de la actividad del día: UN evento del libro `gestiones`.
 *
 * Antes esto era una fila de `payment_plan` filtrada por `fecha_pago_real`.
 * Esa columna ya no se escribe (queda NULL siempre), así que la actividad del
 * día se lee del libro de eventos: `fecha_gestion` es el día de negocio y
 * `fecha_hora` el instante real de la visita.
 *
 * La cuota (número, vencimiento y valor) viene del cronograma al que el evento
 * quedó anclado (`cuota_objetivo`); puede no existir cuando el evento no apunta
 * a una cuota concreta (por ejemplo una reversa de secretaría).
 */
type GestionRow = {
  id: string; loan_id: string; ruta: number; ruta_nombre: string
  tipo: TipoGestion
  numero_cuota: number | null; fecha_pago: string | null; valor_cuota: number
  monto: number; hora: string
  cliente_nombre: string; cliente_documento: string
}

type VentaRow = {
  id: string; ruta: number; ruta_nombre: string
  valor: number; valor_cuota: number; numero_cuotas: number
  frecuencia_pago: string; tipo_amortizacion: string
  tipo_venta: string; estado: string; hora: string
  cliente_nombre: string; cliente_documento: string
}

type TransaccionRow = {
  id: number; ruta: number; ruta_nombre: string; tipo: string
  concepto: string; valor: number; hora: string
  observacion: string | null; estadoadmin: string | null
}

type Tab = "pagos" | "no_pagos" | "ventas" | "gastos" | "ingresos" | "retiros"

interface AdminRouteDetailProps {
  currentUserId?: number | string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// El vocabulario (hoy en Colombia, hora, moneda, frecuencia) sale de
// lib/gestion-core.ts para que esta pantalla no tenga su propia definición.

const hora = (ts: string | null | undefined) => horaColombia(ts) || "—"

// Columnas del evento + el cronograma al que quedó anclado + el cliente.
// `cuota_objetivo` apunta a payment_plan y `loan_id` a loans: PostgREST resuelve
// ambos embebidos por su FK.
const COLUMNAS_ACTIVIDAD =
  "id, loan_id, ruta, tipo, monto, fecha_hora, " +
  "cuota:payment_plan(numero_cuota, fecha_pago, valor_cuota), " +
  "loans:loans(clients:clients(nombre_completo, documento))"

// ── Component ─────────────────────────────────────────────────────────────────

export function AdminRouteDetail({ currentUserId }: AdminRouteDetailProps) {
  const [fecha, setFecha] = useState(todayColombia)
  const [rutaFilter, setRutaFilter] = useState("all")
  const [ciudadFilter, setCiudadFilter] = useState("all")
  const [activeTab, setActiveTab] = useState<Tab>("pagos")

  const [rutasDisponibles, setRutasDisponibles] = useState<RutaInfo[]>([])
  const [pagos, setPagos] = useState<GestionRow[]>([])
  const [noPagos, setNoPagos] = useState<GestionRow[]>([])
  const [ventas, setVentas] = useState<VentaRow[]>([])
  const [gastos, setGastos] = useState<TransaccionRow[]>([])
  const [ingresos, setIngresos] = useState<TransaccionRow[]>([])
  const [retiros, setRetiros] = useState<TransaccionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ── Cargar rutas accesibles ────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const supabase = createClient()
      try {
        if (currentUserId) {
          const { data } = await supabase
            .from("usuario_rutas")
            .select("rutas:ruta_id(id, nombre, ciudad)")
            .eq("usuario_id", currentUserId)
          setRutasDisponibles(
            (data ?? []).map((r: any) => r.rutas).filter(Boolean)
              .sort((a: any, b: any) => a.id - b.id) as RutaInfo[],
          )
        } else {
          const { data } = await supabase.from("rutas").select("id, nombre, ciudad").order("id")
          setRutasDisponibles((data ?? []) as RutaInfo[])
        }
      } catch (e) {
        console.error("[v0] AdminRouteDetail rutas error:", e)
      }
    }
    load()
  }, [currentUserId])

  // ── Cargar todo en paralelo ────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (rutasDisponibles.length === 0) { setLoading(false); return }
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const rutaIds = rutasDisponibles.map((r) => r.id)
      const rutaInfoMap = new Map(rutasDisponibles.map((r) => [r.id, r]))
      const dayStart = `${fecha}T00:00:00-05:00`
      const dayEnd   = `${fecha}T23:59:59-05:00`

      // 3 queries en paralelo
      const [gestionesRes, ventasRes, gastosRes] = await Promise.all([
        // gestiones: la actividad del día (pagos + no pagos), del libro de eventos.
        // `fecha_gestion` es el día de negocio, así que no hay que armar rangos
        // de timestamps ni pelear con la zona horaria.
        // `origen <> 'homologacion'`: esos eventos son historia migrada de otro
        // sistema, no actividad de la ruta (mismo criterio que vista_monitoreo_admin).
        supabase
          .from("gestiones")
          .select(COLUMNAS_ACTIVIDAD)
          .in("ruta", rutaIds)
          .eq("fecha_gestion", fecha)
          .eq("estado", "aplicada")
          .neq("origen", "homologacion")
          .order("fecha_hora", { ascending: true }),

        // loans: ventas creadas hoy
        supabase
          .from("loans")
          .select("id, ruta, valor, valor_cuota, numero_cuotas, frecuencia_pago, tipo_amortizacion, tipo_venta, estado, fecha_creacion, clients(nombre_completo, documento)")
          .in("ruta", rutaIds)
          .gte("fecha_creacion", dayStart)
          .lte("fecha_creacion", dayEnd)
          .order("fecha_creacion", { ascending: true }),

        // gastosregistros: gastos, ingresos, retiros del día
        supabase
          .from("gastosregistros")
          .select("id, ruta, tipo, concepto, valor, fechahorasol, observacion, estadoadmin")
          .in("ruta", rutaIds)
          .gte("fechahorasol", dayStart)
          .lte("fechahorasol", dayEnd)
          .in("tipo", ["Gasto", "Ingreso", "Retiro"])
          .order("fechahorasol", { ascending: true }),
      ])

      if (gestionesRes.error) throw gestionesRes.error

      // UNA FILA POR CLIENTE, no una por evento.
      //
      // Antes cada papel del libro era un renglón: un cliente al que
      // secretaría le marcó el pago, se lo quitó, le puso no pago y se lo
      // volvió a marcar aparecía cuatro veces, y la reversa colgaba suelta en
      // la pestaña de Pagos restando. `colapsarPorCliente` aplica la MISMA
      // regla que `resumen_diario_v2` (script 070), así que estas listas y los
      // contadores de las pestañas no pueden discrepar.
      //
      // El nombre del cliente ya viene en el mismo viaje
      // (gestiones → loans → clients), así que se acabó la consulta extra.
      const filas = colapsarPorCliente((gestionesRes.data ?? []) as any[])

      const aFila = (f: (typeof filas)[number]): GestionRow => {
        const g = f.representante as any
        return {
          id: g.id, loan_id: g.loan_id, ruta: g.ruta,
          ruta_nombre: rutaInfoMap.get(g.ruta)?.nombre ?? `Ruta ${g.ruta}`,
          tipo: g.tipo as TipoGestion,
          numero_cuota: g.cuota?.numero_cuota ?? null,
          fecha_pago: g.cuota?.fecha_pago ?? null,
          valor_cuota: Number(g.cuota?.valor_cuota ?? 0),
          // El NETO del cliente ese día: las reversas ya vienen restadas
          // adentro, así que dejaron de necesitar renglón propio.
          monto: f.neto,
          hora: hora(g.fecha_hora),
          cliente_nombre: g.loans?.clients?.nombre_completo ?? "—",
          cliente_documento: g.loans?.clients?.documento ?? "—",
        }
      }

      setPagos(filas.filter((f) => f.estado === "pagado").map(aFila))
      setNoPagos(filas.filter((f) => f.estado === "no_pago").map(aFila))

      // Normalizar ventas
      setVentas(
        ((ventasRes.data ?? []) as any[]).map((l) => ({
          id: l.id, ruta: l.ruta,
          ruta_nombre: rutaInfoMap.get(l.ruta)?.nombre ?? `Ruta ${l.ruta}`,
          valor: l.valor ?? 0, valor_cuota: l.valor_cuota ?? 0,
          numero_cuotas: l.numero_cuotas, frecuencia_pago: l.frecuencia_pago,
          tipo_amortizacion: l.tipo_amortizacion ?? "—", tipo_venta: l.tipo_venta ?? "—",
          estado: l.estado, hora: hora(l.fecha_creacion),
          cliente_nombre: l.clients?.nombre_completo ?? "—",
          cliente_documento: l.clients?.documento ?? "—",
        })),
      )

      // Normalizar gastosregistros
      const toTx = (g: any): TransaccionRow => ({
        id: g.id, ruta: g.ruta,
        ruta_nombre: rutaInfoMap.get(g.ruta)?.nombre ?? `Ruta ${g.ruta}`,
        tipo: g.tipo, concepto: g.concepto, valor: g.valor ?? 0,
        hora: hora(g.fechahorasol), observacion: g.observacion ?? null,
        estadoadmin: g.estadoadmin ?? null,
      })
      const gastosData: any[] = gastosRes.data ?? []
      setGastos(gastosData.filter((g) => g.tipo === "Gasto").map(toTx))
      setIngresos(gastosData.filter((g) => g.tipo === "Ingreso").map(toTx))
      setRetiros(gastosData.filter((g) => g.tipo === "Retiro").map(toTx))

    } catch (e) {
      const msg = (e as any)?.message ?? String(e)
      console.error("[v0] AdminRouteDetail fetch error:", msg)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [fecha, rutasDisponibles])

  useEffect(() => { fetchAll() }, [fetchAll])

  // ── Filtrado local ─────────────────────────────────────────────────────────
  const applyFilter = <T extends { ruta: number }>(rows: T[]) =>
    rows.filter((r) => {
      if (rutaFilter !== "all" && r.ruta !== Number(rutaFilter)) return false
      if (ciudadFilter !== "all" && rutasDisponibles.find((ri) => ri.id === r.ruta)?.ciudad !== ciudadFilter) return false
      return true
    })

  const fPagos    = applyFilter(pagos)
  const fNoPagos  = applyFilter(noPagos)
  const fVentas   = applyFilter(ventas)
  const fGastos   = applyFilter(gastos)
  const fIngresos = applyFilter(ingresos)
  const fRetiros  = applyFilter(retiros)

  const ciudades = Array.from(new Set(rutasDisponibles.map((r) => r.ciudad).filter(Boolean))) as string[]

  const totalPagos    = fPagos.reduce((s, r) => s + r.monto, 0)
  const totalVentas   = fVentas.reduce((s, r) => s + r.valor, 0)
  const totalGastos   = fGastos.reduce((s, r) => s + r.valor, 0)
  const totalIngresos = fIngresos.reduce((s, r) => s + r.valor, 0)
  const totalRetiros  = fRetiros.reduce((s, r) => s + r.valor, 0)

  // ── Tabs config ────────────────────────────────────────────────────────────
  const tabs: { id: Tab; label: string; count: number; icon: React.ElementType; iconColor: string; badgeClass: string }[] = [
    { id: "pagos",     label: "Pagos",      count: fPagos.length,    icon: CheckCircle2,    iconColor: "text-icon-cash",       badgeClass: "bg-success text-success-foreground"      },
    { id: "no_pagos",  label: "No Pagos",   count: fNoPagos.length,  icon: XCircle,         iconColor: "text-destructive",     badgeClass: "bg-destructive text-destructive-foreground" },
    { id: "ventas",    label: "Ventas",     count: fVentas.length,   icon: ShoppingCart,    iconColor: "text-icon-sales",      badgeClass: "bg-info text-info-foreground"            },
    { id: "gastos",    label: "Gastos",     count: fGastos.length,   icon: Receipt,         iconColor: "text-icon-expense",    badgeClass: "bg-destructive text-destructive-foreground" },
    { id: "ingresos",  label: "Ingresos",   count: fIngresos.length, icon: TrendingUp,      iconColor: "text-icon-income",     badgeClass: "bg-success text-success-foreground"      },
    { id: "retiros",   label: "Retiros",    count: fRetiros.length,  icon: ArrowDownCircle, iconColor: "text-icon-withdrawal", badgeClass: "bg-warning text-warning-foreground"      },
  ]

  // ── Helpers de render ──────────────────────────────────────────────────────
  const estadoAdminBadge = (e: string | null) => {
    if (!e || e === "NA") return null
    const cls = e === "aprobado" ? "bg-success/20 text-success" : e === "rechazado" ? "bg-destructive/20 text-destructive" : "bg-warning/20 text-warning"
    return <span className={`text-[9px] rounded px-1.5 py-0.5 font-medium ${cls}`}>{e}</span>
  }

  // La columna "Estado" ahora describe el EVENTO, no el estado de la cuota:
  // la fila es una gestión del libro, no una cuota del cronograma.
  const tipoGestionBadge = (tipo: TipoGestion) => {
    const meta: Record<string, { label: string; clase: string }> = {
      pago:        { label: "Pago",        clase: "bg-success/20 text-success" },
      cancelacion: { label: "Cancelación", clase: "bg-info/20 text-info" },
      abono_venta: { label: "Abono venta", clase: "bg-success/20 text-success" },
      reversa:     { label: "Reversa",     clase: "bg-warning/20 text-warning" },
      no_pago:     { label: "No pago",     clase: "bg-destructive/20 text-destructive" },
    }
    const m = meta[tipo]
    if (!m) return <span className="text-[9px] rounded px-1.5 py-0.5 font-medium bg-muted text-muted-foreground">{tipo}</span>
    return <span className={`text-[9px] rounded px-1.5 py-0.5 font-medium ${m.clase}`}>{m.label}</span>
  }

  const TH = ({ children, right, center }: { children: React.ReactNode; right?: boolean; center?: boolean }) => (
    <TableHead className={`text-[9px] md:text-[10px] font-bold uppercase tracking-wide text-muted-foreground px-2 py-2 whitespace-nowrap ${right ? "text-right" : center ? "text-center" : ""}`}>
      {children}
    </TableHead>
  )
  const TD = ({ children, right, center, className = "" }: { children: React.ReactNode; right?: boolean; center?: boolean; className?: string }) => (
    <TableCell className={`text-[10px] md:text-xs px-2 py-1.5 whitespace-nowrap ${right ? "text-right" : center ? "text-center" : ""} ${className}`}>
      {children}
    </TableCell>
  )

  return (
    <div className="flex flex-col gap-3 md:gap-4">

      {/* ── Filtros ─────────────────────────────────────────────────────────── */}
      <Card className="bg-card shadow-sm border-0">
        <CardContent className="px-3 py-2">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Fecha</Label>
              <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="h-8 w-36 text-xs bg-background border-border" />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Ruta</Label>
              <Select value={rutaFilter} onValueChange={setRutaFilter}>
                <SelectTrigger className="h-8 w-44 text-xs bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las rutas</SelectItem>
                  {rutasDisponibles.map((r) => <SelectItem key={r.id} value={String(r.id)} className="text-xs">{r.nombre || `Ruta ${r.id}`}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {ciudades.length > 0 && (
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Ciudad</Label>
                <Select value={ciudadFilter} onValueChange={setCiudadFilter}>
                  <SelectTrigger className="h-8 w-36 text-xs bg-background border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    {ciudades.map((c) => <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <Button size="sm" variant="outline" onClick={fetchAll} disabled={loading} className="h-8 gap-1.5 text-xs border-border">
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
              Actualizar
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <Card className="bg-card shadow-sm border-0">
        <CardContent className="px-3 py-2">
          <div className="flex flex-wrap gap-1.5">
            {tabs.map(({ id, label, count, icon: Icon, iconColor, badgeClass }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === id
                    ? "bg-brand text-brand-foreground shadow-sm"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${activeTab === id ? "text-brand-foreground" : iconColor}`} />
                {label}
                <span className={`inline-flex items-center justify-center rounded-full text-[9px] font-bold min-w-[16px] h-4 px-1 ${
                  activeTab === id ? "bg-white/20 text-white" : badgeClass
                }`}>
                  {count}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Tabla activa ────────────────────────────────────────────────────── */}
      <Card className="bg-card shadow-sm border-0">
        <CardContent className="p-0">

          {/* Resumen de la sección */}
          <div className="px-3 py-2 border-b border-border/50 flex flex-wrap gap-4 items-center">
            {activeTab === "pagos" && (
              <>
                <span className="text-xs text-muted-foreground">{fPagos.length} registros</span>
                <span className="text-xs font-bold text-success">Total recaudado: {fmtMoneda(totalPagos)}</span>
              </>
            )}
            {activeTab === "no_pagos" && (
              <span className="text-xs text-muted-foreground">{fNoPagos.length} clientes sin pago</span>
            )}
            {activeTab === "ventas" && (
              <>
                <span className="text-xs text-muted-foreground">{fVentas.length} ventas</span>
                <span className="text-xs font-bold text-info">Total colocado: {fmtMoneda(totalVentas)}</span>
              </>
            )}
            {activeTab === "gastos" && (
              <>
                <span className="text-xs text-muted-foreground">{fGastos.length} gastos</span>
                <span className="text-xs font-bold text-destructive">Total: {fmtMoneda(totalGastos)}</span>
              </>
            )}
            {activeTab === "ingresos" && (
              <>
                <span className="text-xs text-muted-foreground">{fIngresos.length} ingresos</span>
                <span className="text-xs font-bold text-success">Total: {fmtMoneda(totalIngresos)}</span>
              </>
            )}
            {activeTab === "retiros" && (
              <>
                <span className="text-xs text-muted-foreground">{fRetiros.length} retiros</span>
                <span className="text-xs font-bold text-warning">Total: {fmtMoneda(totalRetiros)}</span>
              </>
            )}
          </div>

          {loading ? (
            <div className="flex justify-center items-center py-14">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center px-4">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <p className="text-xs text-destructive">{error}</p>
              <Button size="sm" variant="outline" onClick={fetchAll} className="text-xs h-7">Reintentar</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">

              {/* PAGOS */}
              {activeTab === "pagos" && (
                fPagos.length === 0 ? <EmptyState /> : (
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TH>Cliente</TH><TH>Documento</TH><TH>Ruta</TH>
                        <TH center>Cuota #</TH><TH right>Valor Cuota</TH>
                        <TH right>Abonado</TH><TH center>Estado</TH><TH center>Hora</TH>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fPagos.map((r) => (
                        <TableRow key={r.id} className="hover:bg-muted/20 border-b border-border/50">
                          <TD className="font-medium text-foreground">{r.cliente_nombre}</TD>
                          <TD className="text-muted-foreground">{r.cliente_documento}</TD>
                          <TD className="text-muted-foreground">{r.ruta_nombre}</TD>
                          <TD center className="text-muted-foreground">{r.numero_cuota ?? "—"}</TD>
                          <TD right className="text-muted-foreground">{fmtMoneda(r.valor_cuota)}</TD>
                          <TD right className="font-semibold text-success">{fmtMoneda(r.monto)}</TD>
                          <TD center>{tipoGestionBadge(r.tipo)}</TD>
                          <TD center><span className="inline-flex items-center gap-1 text-muted-foreground"><Clock className="h-2.5 w-2.5" />{r.hora}</span></TD>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              )}

              {/* NO PAGOS */}
              {activeTab === "no_pagos" && (
                fNoPagos.length === 0 ? <EmptyState /> : (
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TH>Cliente</TH><TH>Documento</TH><TH>Ruta</TH>
                        <TH center>Cuota #</TH><TH>Fecha Prog.</TH>
                        <TH right>Valor Cuota</TH><TH center>Hora</TH>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fNoPagos.map((r) => (
                        <TableRow key={r.id} className="hover:bg-destructive/5 border-b border-border/50">
                          <TD className="font-medium text-foreground">{r.cliente_nombre}</TD>
                          <TD className="text-muted-foreground">{r.cliente_documento}</TD>
                          <TD className="text-muted-foreground">{r.ruta_nombre}</TD>
                          <TD center className="text-muted-foreground">{r.numero_cuota ?? "—"}</TD>
                          <TD className="text-muted-foreground">{r.fecha_pago ?? "—"}</TD>
                          <TD right className="text-destructive font-medium">{fmtMoneda(r.valor_cuota)}</TD>
                          <TD center><span className="inline-flex items-center gap-1 text-muted-foreground"><Clock className="h-2.5 w-2.5" />{r.hora}</span></TD>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              )}

              {/* VENTAS */}
              {activeTab === "ventas" && (
                fVentas.length === 0 ? <EmptyState /> : (
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TH>Cliente</TH><TH>Documento</TH><TH>Ruta</TH>
                        <TH right>Valor</TH><TH right>Cuota</TH>
                        <TH center>Cuotas</TH><TH center>Frec.</TH>
                        <TH center>Tipo</TH><TH center>Hora</TH>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fVentas.map((r) => (
                        <TableRow key={r.id} className="hover:bg-muted/20 border-b border-border/50">
                          <TD className="font-medium text-foreground">{r.cliente_nombre}</TD>
                          <TD className="text-muted-foreground">{r.cliente_documento}</TD>
                          <TD className="text-muted-foreground">{r.ruta_nombre}</TD>
                          <TD right className="font-semibold text-info">{fmtMoneda(r.valor)}</TD>
                          <TD right className="text-muted-foreground">{fmtMoneda(r.valor_cuota)}</TD>
                          <TD center className="text-muted-foreground">{r.numero_cuotas}</TD>
                          <TD center className="text-muted-foreground">{etiquetaFrecuencia(r.frecuencia_pago)}</TD>
                          <TD center className="capitalize text-muted-foreground">{r.tipo_amortizacion}</TD>
                          <TD center><span className="inline-flex items-center gap-1 text-muted-foreground"><Clock className="h-2.5 w-2.5" />{r.hora}</span></TD>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              )}

              {/* GASTOS / INGRESOS / RETIROS */}
              {(activeTab === "gastos" || activeTab === "ingresos" || activeTab === "retiros") && (() => {
                const rows = activeTab === "gastos" ? fGastos : activeTab === "ingresos" ? fIngresos : fRetiros
                const valueColor = activeTab === "gastos" ? "text-destructive" : activeTab === "ingresos" ? "text-success" : "text-warning"
                return rows.length === 0 ? <EmptyState /> : (
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TH>Ruta</TH><TH>Concepto</TH>
                        <TH right>Valor</TH><TH center>Hora</TH>
                        <TH>Observación</TH><TH center>Estado</TH>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.id} className="hover:bg-muted/20 border-b border-border/50">
                          <TD className="text-muted-foreground">{r.ruta_nombre}</TD>
                          <TD className="font-medium text-foreground">{r.concepto}</TD>
                          <TD right className={`font-semibold ${valueColor}`}>{fmtMoneda(r.valor)}</TD>
                          <TD center><span className="inline-flex items-center gap-1 text-muted-foreground"><Clock className="h-2.5 w-2.5" />{r.hora}</span></TD>
                          <TD className="text-muted-foreground max-w-[160px] truncate">{r.observacion ?? "—"}</TD>
                          <TD center>{estadoAdminBadge(r.estadoadmin) ?? <span className="text-muted-foreground">—</span>}</TD>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              })()}

            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <User className="h-7 w-7 text-muted-foreground/40" />
      <p className="text-xs text-muted-foreground">Sin registros para los filtros seleccionados.</p>
    </div>
  )
}
