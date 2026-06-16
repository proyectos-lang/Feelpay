"use client"

import React from "react"
import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Target, Wallet, Banknote, ShoppingCart, CheckCircle, XCircle, TrendingUp, Receipt, Calendar, Clock, MoreVertical, ArrowDownCircle, RotateCcw, CalendarDays, CalendarClock, CalendarRange, Coins, PiggyBank, Users, PieChart, LockKeyhole, Eye, X, Play, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
 import { createClient } from "@/lib/supabase/client"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type RutaDiariaEstado = "abierta" | "cerrada" | null

interface DailySummaryProps {
  onViewChange?: (view: string) => void
  rutaId?: number
  onRouteStateChange?: (estado: RutaDiariaEstado) => void
}

interface GastoRegistro {
  id: number
  tipo: string
  concepto: string
  valor: number
  fechahorasol: string
  observacion?: string
}

export function DailySummary({ onViewChange, rutaId = 1, onRouteStateChange }: DailySummaryProps) {
  const [isFlipped, setIsFlipped] = useState(false)

  // Estado de la ruta diaria
  const [rutaDiariaId, setRutaDiariaId] = useState<number | null>(null)
  const [rutaDiariaEstado, setRutaDiariaEstado] = useState<RutaDiariaEstado>(null)
  const [loadingRutaDiaria, setLoadingRutaDiaria] = useState(true)
  const [processingRuta, setProcessingRuta] = useState(false)
  const [selectedDate] = useState(() =>
    new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(new Date())
  )

  // Real data from resumen_pagos_diarios
  const [collectedAmount, setCollectedAmount] = useState(0)
  const [metaAmount, setMetaAmount] = useState(0)
  const [cantidadPagos, setCantidadPagos] = useState(0)
  const [cantidadNoPagos, setCantidadNoPagos] = useState(0)
  const [valorIngresos, setValorIngresos] = useState(0)
  const [valorGastos, setValorGastos] = useState(0)
  const [valorRetiros, setValorRetiros] = useState(0)
  const [valorCanceladas, setValorCanceladas] = useState(0)
  // Total de ventas del dia (suma de loans creados hoy en la ruta).
  // Viene del campo `valor_ventas` en `resumen_pagos_diarios`.
  const [valorVentas, setValorVentas] = useState(0)
  // Efectivo del dia y caja anterior (efectivo del ultimo dia con resumen
  // anterior al actual). Ambos vienen de `resumen_pagos_diarios.efectivo`.
  const [efectivo, setEfectivo] = useState(0)
  const [cajaAnterior, setCajaAnterior] = useState(0)
  // Sumas de capital e intereses del recaudo del dia. Salen de
  // `payment_plan.pago_capital` y `payment_plan.pago_intereses` para las
  // cuotas pagadas/parciales/canceladas hoy.
  const [pagoCapital, setPagoCapital] = useState(0)
  const [pagoIntereses, setPagoIntereses] = useState(0)
  const [loadingResumen, setLoadingResumen] = useState(true)

  // Estado para el diálogo de detalle de gastos/ingresos/retiros
  const [detailDialogOpen, setDetailDialogOpen] = useState(false)
  const [detailType, setDetailType] = useState<"Ingreso" | "Gasto" | "Retiro" | null>(null)
  const [detailRecords, setDetailRecords] = useState<GastoRegistro[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  useEffect(() => {
    const fetchResumen = async () => {
      try {
        const supabase = createClient()
        // Fecha de hoy en zona Colombia
        const colombiaFormatter = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Bogota",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
        const fechaHoy = colombiaFormatter.format(new Date())

        // ── Queries directas filtradas por ruta ──────────────────────
        // RLS eliminado: filtramos explicitamente con `.eq('ruta', rutaId)`.
        const { data, error } = await supabase
          .from("resumen_pagos_diarios")
          .select("valor_pago, meta_pagos, valor_ingresos, valor_gastos, valor_retiros, valor_canceladas, valor_ventas, efectivo, pago_capital, pago_intereses")
          .eq("fecha_pago", fechaHoy)
          .eq("ruta", rutaId)
          .maybeSingle()

        if (error) {
          console.error("[v0] legacy resumen_pagos_diarios error:", error.message)
        }
        if (data) {
          const d = data as Record<string, number | null>
          setCollectedAmount(d.valor_pago ?? 0)
          setMetaAmount(d.meta_pagos ?? 0)
          setValorIngresos(d.valor_ingresos ?? 0)
          setValorGastos(d.valor_gastos ?? 0)
          setValorRetiros(d.valor_retiros ?? 0)
          setValorCanceladas(d.valor_canceladas ?? 0)
          setValorVentas(d.valor_ventas ?? 0)
          setEfectivo(d.efectivo ?? 0)
          setPagoCapital(d.pago_capital ?? 0)
          setPagoIntereses(d.pago_intereses ?? 0)
        } else {
          // No hay resumen para hoy: dejamos todos los valores en 0.
          setEfectivo(0)
          setPagoCapital(0)
          setPagoIntereses(0)
        }

        // ── Caja Anterior: efectivo del resumen mas reciente con
        // `fecha_pago < fechaHoy` para esta ruta. Tomamos solo 1 registro
        // ordenado descendentemente para obtener el "ultimo dia operado".
        const { data: prevData, error: prevError } = await supabase
          .from("resumen_pagos_diarios")
          .select("efectivo, fecha_pago")
          .eq("ruta", rutaId)
          .lt("fecha_pago", fechaHoy)
          .order("fecha_pago", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (prevError) {
          console.error("[v0] caja anterior error:", prevError.message)
        }
        setCajaAnterior(
          (prevData as { efectivo?: number | null } | null)?.efectivo ?? 0,
        )

        const { count: pagosCount, error: pagosError } = await supabase
          .from("payment_plan")
          .select("*", { count: "exact", head: true })
          .eq("fecha_pago", fechaHoy)
          .eq("ruta", rutaId)
          .in("estado", ["pagado", "parcial", "cancelada"])
          .gt("monto_pagado", 0)
        if (pagosError) console.error("[v0] legacy pagos count error:", pagosError.message)
        else setCantidadPagos(pagosCount ?? 0)

        const { count: noPagosCount, error: noPagosError } = await supabase
          .from("payment_plan")
          .select("*", { count: "exact", head: true })
          .eq("fecha_pago", fechaHoy)
          .eq("ruta", rutaId)
          .eq("estado", "no_pago")
        if (noPagosError) console.error("[v0] legacy no_pagos count error:", noPagosError.message)
        else setCantidadNoPagos(noPagosCount ?? 0)

      } catch (err) {
        console.error("[v0] Unexpected error fetching resumen:", err)
      } finally {
        setLoadingResumen(false)
      }
    }

    fetchResumen()
  }, [rutaId])

  // Helper: obtener fecha de hoy en formato YYYY-MM-DD (zona Colombia)
  const getFechaHoyColombia = () => {
    const colombiaFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    return colombiaFormatter.format(new Date())
  }

  // Consultar estado de la ruta diaria al montar / cambiar rutaId.
  //
  // SELECT directo sobre `rutas_diarias` filtrando por ruta_id y fecha.
  // (RLS eliminado.)
  useEffect(() => {
    const fetchRutaDiaria = async () => {
      try {
        setLoadingRutaDiaria(true)
        const supabase = createClient()
        const fechaHoy = getFechaHoyColombia()

        const { data, error } = await supabase
          .from("rutas_diarias")
          .select("id, estado")
          .eq("ruta_id", rutaId)
          .eq("fecha", fechaHoy)
          .maybeSingle()

        if (error) {
          console.error("[v0] rutas_diarias error:", error.message)
          setRutaDiariaId(null)
          setRutaDiariaEstado(null)
        } else if (data) {
          setRutaDiariaId(data.id)
          setRutaDiariaEstado(data.estado as RutaDiariaEstado)
          onRouteStateChange?.(data.estado as RutaDiariaEstado)
        } else {
          setRutaDiariaId(null)
          setRutaDiariaEstado(null)
          onRouteStateChange?.(null)
        }
      } catch (err) {
        console.error("[v0] Unexpected error fetching rutas_diarias:", err)
      } finally {
        setLoadingRutaDiaria(false)
      }
    }

    fetchRutaDiaria()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rutaId])

  const handleIniciarRuta = async () => {
    if (processingRuta) return
    try {
      setProcessingRuta(true)
      const supabase = createClient()
      const fechaHoy = getFechaHoyColombia()

      const { data, error } = await supabase
        .from("rutas_diarias")
        .insert({
          ruta_id: rutaId,
          fecha: fechaHoy,
          estado: "abierta",
        })
        .select("id, estado")
        .single()

      if (error) {
        console.error("[v0] Error iniciando ruta:", error.message)
        return
      }

      if (data) {
        setRutaDiariaId(data.id)
        setRutaDiariaEstado("abierta")
        onRouteStateChange?.("abierta")
      }
    } catch (err) {
      console.error("[v0] Unexpected error iniciando ruta:", err)
    } finally {
      setProcessingRuta(false)
    }
  }

  // Función para cargar detalles de gastos/ingresos/retiros
  const fetchDetailRecords = async (tipo: "Ingreso" | "Gasto" | "Retiro") => {
    setDetailType(tipo)
    setDetailDialogOpen(true)
    setLoadingDetail(true)
    setDetailRecords([])

    try {
      const supabase = createClient()
      
      // Get today's date in Colombia timezone (start and end of day)
      const now = new Date()
      const colombiaFormatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
      const todayColombia = colombiaFormatter.format(now)
      const startOfDay = `${todayColombia}T00:00:00`
      const endOfDay = `${todayColombia}T23:59:59`

      const { data, error } = await supabase
        .from("gastosregistros")
        .select("id, tipo, concepto, valor, fechahorasol, observacion")
        .eq("tipo", tipo)
        .eq("ruta", rutaId)
        .gte("fechahorasol", startOfDay)
        .lte("fechahorasol", endOfDay)
        .order("fechahorasol", { ascending: false })

      if (error) {
        console.error("[v0] Error fetching detail records:", error.message)
        return
      }

      setDetailRecords(data || [])
    } catch (err) {
      console.error("[v0] Error fetching detail:", err)
    } finally {
      setLoadingDetail(false)
    }
  }

  // Mock data - back card (detailed report)
  const reportData = {
    totalPayments: cantidadPagos,
    totalPending: cantidadPagos + cantidadNoPagos,
    frequency: {
      diario: { pagos: 28, total: 35 },
      semanal: { pagos: 3, total: 5 },
      quincenal: { pagos: 1, total: 2 },
      mensual: { pagos: 1, total: 1 },
      intereses: { pagos: 2, total: 3 },
    },
    installmentsByClient: {
      small: 12,
      large: 23,
    },
    salesReport: {
      nuevas: 1,
      renovaciones: 0,
      total: 2,
    },
    portfolioStatus: {
      alDia: 22,
      mora: 18,
      vencidos: 10,
    },
  }

  const currentTime = new Date().toLocaleTimeString("es-CO", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Bogota",
  })

  const collectionPercentage = metaAmount > 0 ? (collectedAmount / metaAmount) * 100 : 0
  const remaining = metaAmount - collectedAmount
  const paymentPercentage = reportData.totalPending > 0 ? (reportData.totalPayments / reportData.totalPending) * 100 : 0

  // Calculate pie chart segments
  const totalPortfolio = reportData.portfolioStatus.alDia + reportData.portfolioStatus.mora + reportData.portfolioStatus.vencidos
  const alDiaPercent = (reportData.portfolioStatus.alDia / totalPortfolio) * 100
  const moraPercent = (reportData.portfolioStatus.mora / totalPortfolio) * 100

  return (
    <div className="flex flex-col h-full min-h-0 bg-background" style={{ perspective: "1000px" }}>
      {/* Flip card container */}
      <div
        className="relative w-full h-full transition-transform duration-700"
        style={{
          transformStyle: "preserve-3d",
          transform: isFlipped ? "rotateY(180deg)" : "rotateY(0deg)",
        }}
      >
        {/* FRONT SIDE */}
        <div
          className={`absolute inset-0 flex flex-col bg-background ${isFlipped ? "invisible" : "visible"}`}
          style={{ backfaceVisibility: "hidden" }}
        >
          {/* Header with gradient */}
          <div className="bg-brand-gradient text-brand-foreground px-4 pt-4 pb-3 rounded-b-2xl shadow-lg">
            <div className="flex items-center justify-between mb-2 gap-2">
              <h1 className="text-2xl font-bold tracking-tight">Resumen del Día</h1>
              <div className="flex items-center gap-1">
                {/* Botón Iniciar / Finalizar Ruta */}
                {!loadingRutaDiaria && (
                  <>
                    {rutaDiariaEstado === null && (
                      <Button
                        size="sm"
                        className="bg-success hover:bg-success/90 text-success-foreground h-8 px-3 font-semibold gap-1.5"
                        onClick={handleIniciarRuta}
                        disabled={processingRuta}
                        title="Iniciar Ruta del Día"
                      >
                        {processingRuta ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                        <span className="hidden sm:inline">Iniciar Ruta</span>
                      </Button>
                    )}
                    {rutaDiariaEstado === "cerrada" && (
                      <Badge className="bg-white text-foreground border-0 h-8 px-3 font-semibold gap-1.5 flex items-center">
                        <CheckCircle className="h-4 w-4 text-success" />
                        <span className="hidden sm:inline">Ruta Completada</span>
                      </Badge>
                    )}
                  </>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-brand-foreground hover:bg-white/20 h-8 w-8"
                  title="Cierre de Caja"
                  onClick={() => onViewChange?.("cierre-caja")}
                >
                  <LockKeyhole className="h-5 w-5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-brand-foreground hover:bg-white/20 h-8 w-8"
                  onClick={() => setIsFlipped(true)}
                >
                  <RotateCcw className="h-5 w-5" />
                </Button>
                <Button variant="ghost" size="icon" className="text-brand-foreground hover:bg-white/20 h-8 w-8">
                  <MoreVertical className="h-5 w-5" />
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <div className="flex items-center gap-1.5 text-brand-foreground/90">
                <Calendar className="h-4 w-4" />
                <span>{selectedDate}</span>
              </div>
              <div className="flex items-center gap-1.5 text-brand-foreground/90">
                <Clock className="h-4 w-4" />
                <span>{currentTime}</span>
              </div>
              <Badge className="bg-white text-foreground border-0 ml-auto text-sm">
                Estado:{" "}
                {rutaDiariaEstado === "abierta" ? (
                  <span className="text-success ml-1 font-semibold">Abierta</span>
                ) : rutaDiariaEstado === "cerrada" ? (
                  <span className="text-warning ml-1 font-semibold">Cerrada</span>
                ) : (
                  <span className="text-muted-foreground ml-1 font-semibold">Sin Iniciar</span>
                )}
              </Badge>
            </div>
          </div>

          {/* Content area - compact spacing */}
          <div className="flex-1 px-3 py-2 space-y-2 overflow-auto">
            {/* Caja Anterior & Efectivo */}
            <div className="grid grid-cols-2 gap-1.5">
              <Card className="bg-card shadow-sm border-0">
                <CardContent className="px-2 py-px flex items-center gap-1">
                  <div className="h-5 w-5 rounded bg-warning-light flex items-center justify-center shrink-0">
                    <Wallet className="h-3.5 w-3.5 text-icon-wallet" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground font-medium leading-none">Caja Anterior</p>
                    <p className="text-lg font-bold text-info leading-none">${cajaAnterior.toLocaleString()}</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card shadow-sm border-0">
                <CardContent className="px-2 py-px flex items-center gap-1">
                  <div className="h-5 w-5 rounded bg-success-light flex items-center justify-center shrink-0">
                    <Banknote className="h-3.5 w-3.5 text-icon-cash" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground font-medium leading-none">Efectivo</p>
                    <p className="text-lg font-bold text-success leading-none">${efectivo.toLocaleString()}</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Resumen Financiero - Horizontal Bar Chart */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="px-3 py-2">
                <p className="text-sm font-semibold text-foreground mb-1.5">Resumen Financiero</p>
                
                {(() => {
                  const items: { label: string; value: number; color: string; textColor: string; icon: React.ElementType; detailType?: "Ingreso" | "Gasto" | "Retiro"; maxOverride?: number }[] = [
                    { label: "Canceladas", value: valorCanceladas, color: "bg-warning", textColor: "text-icon-check", icon: CheckCircle, maxOverride: collectedAmount },
                    { label: "Ventas", value: valorVentas, color: "bg-info", textColor: "text-icon-sales", icon: ShoppingCart },
                    { label: "Ingresos", value: valorIngresos, color: "bg-success", textColor: "text-icon-income", icon: TrendingUp, detailType: "Ingreso" },
                    { label: "Gastos", value: valorGastos, color: "bg-destructive", textColor: "text-icon-expense", icon: Receipt, detailType: "Gasto" },
                    { label: "Retiros", value: valorRetiros, color: "bg-icon-withdrawal", textColor: "text-icon-withdrawal", icon: ArrowDownCircle, detailType: "Retiro" },
                  ]
                  const maxValue = Math.max(...items.map(i => i.value), 1)
                  
                  return (
                    <div className="space-y-1">
                      {items.map((item) => {
                        const barMax = item.maxOverride ?? maxValue
                        const barPercent = barMax > 0 ? Math.min((item.value / barMax) * 100, 100) : 0
                        return (
                          <div key={item.label} className="flex items-center gap-1.5">
                            <item.icon className={`h-3.5 w-3.5 ${item.textColor} shrink-0`} />
                            <span className="text-sm text-muted-foreground w-20 truncate">{item.label}</span>
                            <div className="flex-1 h-3.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full ${item.color} rounded-full transition-all`}
                                style={{ width: `${barPercent}%` }}
                              />
                            </div>
                            <span className="text-sm font-bold text-foreground w-16 text-right">
                              ${item.value.toLocaleString()}
                            </span>
                            {item.detailType && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-4 w-4 p-0 shrink-0"
                                onClick={() => fetchDetailRecords(item.detailType!)}
                              >
                                <Eye className="h-3 w-3 text-muted-foreground" />
                              </Button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </CardContent>
            </Card>

            {/* Meta vs Recaudo - Gauge */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="px-3 py-2">
                {/* Semi-circular gauge */}
                <div className="relative flex flex-col items-center">
                  {(() => {
                    // Dynamic color based on percentage: 0-50% red, 51-70% yellow, >70% green
                    const gaugeColor = collectionPercentage <= 50 
                      ? "var(--destructive)" 
                      : collectionPercentage <= 70 
                        ? "var(--warning)" 
                        : "var(--success)"
                    
                    return (
                      <svg viewBox="0 0 200 110" className="w-36 h-20">
                        {/* Background arc (gray) */}
                        <path
                          d="M 20 100 A 80 80 0 0 1 180 100"
                          fill="none"
                          stroke="var(--border)"
                          strokeWidth="14"
                          strokeLinecap="round"
                        />
                        {/* Progress arc */}
                        <path
                          d="M 20 100 A 80 80 0 0 1 180 100"
                          fill="none"
                          stroke={gaugeColor}
                          strokeWidth="14"
                          strokeLinecap="round"
                          strokeDasharray={`${(collectionPercentage / 100) * 251.2} 251.2`}
                        />
                        {/* Center percentage text */}
                        <text x="100" y="88" textAnchor="middle" className="text-4xl font-bold" fill={gaugeColor}>
                          {Math.round(collectionPercentage)}%
                        </text>
                      </svg>
                    )
                  })()}
                  
                  {/* Labels below gauge */}
                  <div className="flex justify-end w-full px-4 -mt-1">
                    <span className="text-base font-semibold text-foreground">${metaAmount.toLocaleString()}</span>
                  </div>
                  
                  {/* Values row */}
                  <div className="flex items-center justify-center gap-6 mt-1">
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground">Recaudo</p>
                      <p className="text-2xl font-bold text-foreground">${collectedAmount.toLocaleString()}</p>
                    </div>
                    <div className="h-8 w-px bg-border" />
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground">Meta</p>
                      <p className="text-2xl font-bold text-foreground">${metaAmount.toLocaleString()}</p>
                    </div>
                  </div>
                </div>
                
                {collectedAmount >= metaAmount && metaAmount > 0 ? (
                  <p className="text-center text-base font-bold text-success mt-0.5">
                    Superaste la meta del día
                  </p>
                ) : (
                  <p className="text-center text-base text-muted-foreground mt-0.5">
                    Faltan <span className="font-bold text-destructive">${remaining.toLocaleString()}</span> para cumplir la meta
                  </p>
                )}

                {/* Pagos / No Pagos counts */}
                <div className="flex items-center justify-center gap-4 mt-1.5 pt-1.5 border-t border-border">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle className="h-6 w-6 text-success" />
                    <span className="text-base text-muted-foreground">Pagos:</span>
                    <span className="text-base font-bold text-success">{cantidadPagos}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <XCircle className="h-6 w-6 text-destructive" />
                    <span className="text-base text-muted-foreground">No Pagos:</span>
                    <span className="text-base font-bold text-destructive">{cantidadNoPagos}</span>
                  </div>
                </div>

                {/* ── Desglose Capital / Intereses ─────────────────────
                    Dos mini-tarjetas que muestran la composicion del
                    recaudo del dia: cuanto fue a capital y cuanto a
                    intereses. Cada tarjeta indica el porcentaje sobre
                    el recaudo total (collectedAmount). */}
                {(() => {
                  const totalRecaudo = collectedAmount
                  const pctCapital = totalRecaudo > 0 ? (pagoCapital / totalRecaudo) * 100 : 0
                  const pctIntereses = totalRecaudo > 0 ? (pagoIntereses / totalRecaudo) * 100 : 0
                  return (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <div className="rounded-lg border border-border bg-card px-3 py-2">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-medium text-muted-foreground">Capital</span>
                          <span className="text-[10px] font-bold text-primary">
                            {pctCapital.toFixed(1)}%
                          </span>
                        </div>
                        <p className="text-base font-bold text-foreground mt-0.5 leading-tight">
                          ${pagoCapital.toLocaleString()}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border bg-card px-3 py-2">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-medium text-muted-foreground">Intereses</span>
                          <span className="text-[10px] font-bold text-primary">
                            {pctIntereses.toFixed(1)}%
                          </span>
                        </div>
                        <p className="text-base font-bold text-foreground mt-0.5 leading-tight">
                          ${pagoIntereses.toLocaleString()}
                        </p>
                      </div>
                    </div>
                  )
                })()}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* BACK SIDE - Informe Recaudo */}
        <div
          className={`absolute inset-0 flex flex-col bg-background ${isFlipped ? "visible" : "invisible"}`}
          style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
        >
          {/* Header with gradient - matching front */}
          <div className="bg-brand-gradient text-brand-foreground px-4 pt-4 pb-3 rounded-b-2xl shadow-lg">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold tracking-tight">Informe Recaudo</h1>
              <Button
                variant="ghost"
                size="icon"
                className="text-brand-foreground hover:bg-foreground/20 h-8 w-8"
                onClick={() => setIsFlipped(false)}
              >
                <RotateCcw className="h-5 w-5" />
              </Button>
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 px-3 py-2 space-y-2 overflow-auto">
            {/* Pagos Realizados - Gauge Card */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  {/* Circular progress gauge */}
                  <div className="relative w-20 h-20">
                    <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="var(--border)"
                        strokeWidth="10"
                      />
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="url(#pagosGradient2)"
                        strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={`${paymentPercentage * 2.51} 251`}
                      />
                      <defs>
                        <linearGradient id="pagosGradient2" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="var(--success)" />
                          <stop offset="100%" stopColor="var(--success)" />
                        </linearGradient>
                      </defs>
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-base font-bold text-brand">{Math.round(paymentPercentage)}%</span>
                    </div>
                  </div>
                  {/* Pagos stats */}
                  <div className="flex-1 pl-4">
                    <p className="text-sm text-muted-foreground font-medium">Pagos Realizados</p>
                    <p className="text-3xl font-bold text-foreground">
                      {reportData.totalPayments} <span className="text-muted-foreground text-xl font-normal">/ {reportData.totalPending}</span>
                    </p>
                    <div className="w-full bg-muted rounded-full h-2 mt-1 overflow-hidden">
                      <div
                        className="bg-success h-full rounded-full transition-all"
                        style={{ width: `${paymentPercentage}%` }}
                      />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Frecuencia de Pago & Cuotas por Clientes - Side by Side */}
            <div className="grid grid-cols-2 gap-2">
              {/* Frecuencia de Pago */}
              <Card className="bg-card shadow-sm border-0">
                <CardContent className="p-2">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="h-5 w-5 rounded-full bg-info-light flex items-center justify-center">
                      <Clock className="h-2.5 w-2.5 text-icon-calendar" />
                    </div>
                    <span className="text-xs font-semibold text-foreground">Frecuencia de Pago</span>
                  </div>
                  <div className="space-y-0.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <CheckCircle className="h-2.5 w-2.5 text-success" />
                        <span className="text-xs text-muted-foreground">Diario:</span>
                      </div>
                      <span className="text-xs font-bold text-foreground">
                        {reportData.frequency.diario.pagos}
                        <span className="text-muted-foreground font-normal">/{reportData.frequency.diario.total}</span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <CalendarDays className="h-2.5 w-2.5 text-icon-calendar" />
                        <span className="text-xs text-muted-foreground">Semanal:</span>
                      </div>
                      <span className="text-xs font-bold text-foreground">
                        {reportData.frequency.semanal.pagos}
                        <span className="text-muted-foreground font-normal">/{reportData.frequency.semanal.total}</span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <CalendarClock className="h-2.5 w-2.5 text-icon-clock" />
                        <span className="text-xs text-muted-foreground">Quincenal:</span>
                      </div>
                      <span className="text-xs font-bold text-foreground">
                        {reportData.frequency.quincenal.pagos}
                        <span className="text-muted-foreground font-normal">/{reportData.frequency.quincenal.total}</span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <CalendarRange className="h-2.5 w-2.5 text-icon-withdrawal" />
                        <span className="text-xs text-muted-foreground">Mensual:</span>
                      </div>
                      <span className="text-xs font-bold text-foreground">
                        {reportData.frequency.mensual.pagos}
                        <span className="text-muted-foreground font-normal">/{reportData.frequency.mensual.total}</span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <Coins className="h-2.5 w-2.5 text-icon-wallet" />
                        <span className="text-xs text-muted-foreground">Intereses:</span>
                      </div>
                      <span className="text-xs font-bold text-foreground">
                        {reportData.frequency.intereses.pagos}
                        <span className="text-muted-foreground font-normal">/{reportData.frequency.intereses.total}</span>
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Cuotas por Clientes */}
              <Card className="bg-card shadow-sm border-0">
                <CardContent className="p-2">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="h-5 w-5 rounded-full bg-success-light flex items-center justify-center">
                      <Users className="h-2.5 w-2.5 text-icon-users" />
                    </div>
                    <span className="text-xs font-semibold text-foreground">Cuotas por Clientes</span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <PiggyBank className="h-2.5 w-2.5 text-icon-sales" />
                        <span className="text-xs text-muted-foreground">De 0.1 - 3:</span>
                      </div>
                      <span className="text-xs font-bold text-foreground">{reportData.installmentsByClient.small}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <Coins className="h-2.5 w-2.5 text-icon-wallet" />
                        <span className="text-xs text-muted-foreground">Mayor a 3:</span>
                      </div>
                      <span className="text-xs font-bold text-foreground">{reportData.installmentsByClient.large}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Informe Ventas */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-2 bg-brand rounded-lg px-2 py-1">
                  <ShoppingCart className="h-3 w-3 text-brand-foreground" />
                  <span className="text-xs font-semibold text-brand-foreground">Informe Ventas</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-end gap-3">
                    {/* Bar chart */}
                    <div className="flex items-end gap-2 h-14">
                      <div className="flex flex-col items-center">
                        <span className="text-xs font-bold text-info mb-1">{reportData.salesReport.nuevas}</span>
                        <div
                          className="w-8 bg-info rounded-t"
                          style={{ height: `${Math.max(reportData.salesReport.nuevas * 20, 8)}px` }}
                        />
                        <span className="text-[10px] text-muted-foreground mt-1">Nuevas</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-xs font-bold text-warning mb-1">{reportData.salesReport.renovaciones}</span>
                        <div
                          className="w-8 bg-warning rounded-t"
                          style={{ height: `${Math.max(reportData.salesReport.renovaciones * 20, 8)}px` }}
                        />
                        <span className="text-[10px] text-muted-foreground mt-1">Renov.</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 border border-border rounded-lg p-2">
                    <CalendarDays className="h-5 w-5 text-icon-calendar" />
                    <span className="text-xl font-bold text-foreground">{reportData.salesReport.total}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Estado de la Cartera */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-2 bg-brand rounded-lg px-2 py-1">
                  <PieChart className="h-3 w-3 text-brand-foreground" />
                  <span className="text-xs font-semibold text-brand-foreground">Estado de la Cartera</span>
                </div>
                <div className="flex items-center justify-between">
                  {/* Pie chart */}
                  <div className="relative w-24 h-24">
                    <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                      {/* Al Dia */}
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="var(--status-al-dia)"
                        strokeWidth="20"
                        strokeDasharray={`${alDiaPercent * 2.51} 251`}
                        strokeDashoffset="0"
                      />
                      {/* Mora */}
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="var(--status-mora)"
                        strokeWidth="20"
                        strokeDasharray={`${moraPercent * 2.51} 251`}
                        strokeDashoffset={`${-alDiaPercent * 2.51}`}
                      />
                      {/* Vencidos */}
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="var(--status-vencido)"
                        strokeWidth="20"
                        strokeDasharray={`${(100 - alDiaPercent - moraPercent) * 2.51} 251`}
                        strokeDashoffset={`${-(alDiaPercent + moraPercent) * 2.51}`}
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="text-center">
                        <span className="text-[10px] text-status-al-dia font-bold">Al Día</span>
                        <p className="text-base font-bold text-status-al-dia">{reportData.portfolioStatus.alDia}</p>
                      </div>
                    </div>
                  </div>
                  {/* Legend */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-status-al-dia" />
                      <span className="text-xs text-muted-foreground">Al Día</span>
                      <span className="text-xs font-bold text-status-al-dia">{reportData.portfolioStatus.alDia}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-status-mora" />
                      <span className="text-xs text-muted-foreground">Mora</span>
                      <span className="text-xs font-bold text-status-mora">{reportData.portfolioStatus.mora}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-status-vencido" />
                      <span className="text-xs text-muted-foreground">Vencidos</span>
                      <span className="text-xs font-bold text-status-vencido">{reportData.portfolioStatus.vencidos}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Dialog para detalle de Ingresos/Gastos/Retiros */}
      <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detailType === "Ingreso" && <TrendingUp className="h-5 w-5 text-success" />}
              {detailType === "Gasto" && <Receipt className="h-5 w-5 text-destructive" />}
              {detailType === "Retiro" && <ArrowDownCircle className="h-5 w-5 text-icon-withdrawal" />}
              {detailType}s del Día
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-auto">
            {loadingDetail ? (
              <div className="flex items-center justify-center py-8">
                <span className="text-sm text-muted-foreground">Cargando...</span>
              </div>
            ) : detailRecords.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <span className="text-sm text-muted-foreground">No hay {detailType?.toLowerCase()}s registrados hoy</span>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Hora</TableHead>
                    <TableHead className="text-xs">Concepto</TableHead>
                    <TableHead className="text-xs text-right">Valor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailRecords.map((record) => {
                    const fecha = new Date(record.fechahorasol)
                    const hora = fecha.toLocaleTimeString("es-CO", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: true,
                      timeZone: "America/Bogota",
                    })
                    return (
                      <TableRow key={record.id}>
                        <TableCell className="text-xs text-muted-foreground">{hora}</TableCell>
                        <TableCell className="text-xs">
                          <div className="truncate max-w-[150px]" title={record.concepto}>
                            {record.concepto}
                          </div>
                          {record.observacion && (
                            <div className="text-[10px] text-muted-foreground truncate max-w-[150px]" title={record.observacion}>
                              {record.observacion}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs font-medium text-right">
                          ${record.valor.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>
          
          {detailRecords.length > 0 && (
            <div className="border-t pt-3 mt-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Total:</span>
                <span className="text-sm font-bold">
                  ${detailRecords.reduce((sum, r) => sum + r.valor, 0).toLocaleString()}
                </span>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
