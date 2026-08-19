"use client"

import React from "react"
import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Target, Wallet, Banknote, ShoppingCart, CheckCircle, XCircle, TrendingUp, Receipt, Calendar, Clock, ArrowDownCircle, RotateCcw, CalendarDays, CalendarClock, CalendarRange, Coins, PiggyBank, Users, PieChart, ChartColumnBig, LockKeyhole, Eye, X, Play, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
 import { createClient } from "@/lib/supabase/client"
import { getResumenDia } from "@/lib/resumen-dia"
import { todayColombia, bandaCartera, etiquetaFrecuencia } from "@/lib/gestion-core"
import { getRutaUmbrales } from "@/lib/ruta-umbrales"
import { DetalleClientesDialog } from "@/components/detalle-clientes-dialog"
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

  // Datos reales de `resumen_diario_v2` (la plata del dia sale del libro de
  // eventos `gestiones`, no de los estados de `payment_plan`).
  const [collectedAmount, setCollectedAmount] = useState(0)
  const [metaAmount, setMetaAmount] = useState(0)
  const [cantidadPagos, setCantidadPagos] = useState(0)
  const [cantidadNoPagos, setCantidadNoPagos] = useState(0)
  const [valorIngresos, setValorIngresos] = useState(0)
  const [valorGastos, setValorGastos] = useState(0)
  const [valorRetiros, setValorRetiros] = useState(0)
  const [valorCanceladas, setValorCanceladas] = useState(0)
  // Total de ventas del dia (suma de loans creados hoy en la ruta).
  // Viene del campo `valor_ventas` en `resumen_diario_v2`.
  const [valorVentas, setValorVentas] = useState(0)
  // Efectivo del dia y caja anterior. AMBOS son columnas de la MISMA fila de
  // `resumen_diario_v2`: `efectivo` es el acumulado hasta hoy y
  // `caja_anterior` ese mismo acumulado sin el neto del dia.
  const [efectivo, setEfectivo] = useState(0)
  const [cajaAnterior, setCajaAnterior] = useState(0)
  // El dia no tuvo NINGUN movimiento y la caja viene arrastrada del ultimo
  // dia con registro. Se avisa en pantalla para que un $0 en las tarjetas
  // de movimiento no se lea como "se perdio la plata".
  const [diaSinMovimiento, setDiaSinMovimiento] = useState(false)
  // Recaudo del día partido por forma de pago (script 059).
  const [pagoEfectivo, setPagoEfectivo] = useState(0)
  const [pagoTransferencia, setPagoTransferencia] = useState(0)
  // La unidad trabaja con un solo método de interés. Mientras la config no
  // responde queda en false, o sea se muestra Capital/Intereses — el
  // comportamiento de siempre — en vez de un hueco.
  const [unidadDeUnSoloMetodo, setUnidadDeUnSoloMetodo] = useState(false)

  useEffect(() => {
    let cancelado = false
    getRutaUmbrales(rutaId)
      .then((u) => {
        if (!cancelado) setUnidadDeUnSoloMetodo(u.amortizaciones_habilitadas.length === 1)
      })
      .catch((err) => console.error("[v0] DailySummary umbrales:", err))
    return () => { cancelado = true }
  }, [rutaId])
  // Sumas de capital e intereses del recaudo del dia (aleman vs americano),
  // calculadas por la vista sobre las gestiones del dia.
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
        const fechaHoy = todayColombia()

        // ── Una sola query filtrada por ruta ─────────────────────────
        // RLS eliminado: filtramos explicitamente con `.eq('ruta', rutaId)`.
        //
        // `resumen_diario_v2` trae TODO el dia en una fila: la plata (desde
        // `gestiones`), los conteos y la caja anterior. Antes habia que pegar
        // tres consultas mas (el dia anterior para la caja y dos conteos
        // sobre payment_plan) y cada una traia su propia definicion.
        // `getResumenDia` trae TODO el dia en una fila: la plata (desde
        // `gestiones`), los conteos y la caja anterior.
        //
        // Y resuelve el arrastre: un dia sin NINGUN movimiento —un domingo,
        // sin cuotas venciendo ni caja— no tiene fila en la vista, y esta
        // pantalla mostraba entonces Caja Anterior $0 y Efectivo $0. La plata
        // de la ruta desaparecia cada domingo y volvia el lunes.
        const { fila: d, sinMovimiento } = await getResumenDia(supabase, rutaId, fechaHoy)
        setDiaSinMovimiento(sinMovimiento)

        setCollectedAmount(d.valor_pago ?? 0)
        setMetaAmount(d.meta_pagos ?? 0)
        // Pagos / No Pagos salen de la MISMA fuente que la plata.
        setCantidadPagos(d.cantidad_pagos ?? 0)
        setCantidadNoPagos(d.cantidad_no_pagos ?? 0)
        setValorIngresos(d.valor_ingresos ?? 0)
        setValorGastos(d.valor_gastos ?? 0)
        setValorRetiros(d.valor_retiros ?? 0)
        setValorCanceladas(d.valor_canceladas ?? 0)
        setValorVentas(d.valor_ventas ?? 0)
        setEfectivo(d.efectivo ?? 0)
        setCajaAnterior(d.caja_anterior ?? 0)
        setPagoCapital(d.pago_capital ?? 0)
        setPagoIntereses(d.pago_intereses ?? 0)
        setPagoEfectivo(d.pago_efectivo ?? 0)
        setPagoTransferencia(d.pago_transferencia ?? 0)
      } catch (err) {
        console.error("[v0] Unexpected error fetching resumen:", err)
      } finally {
        setLoadingResumen(false)
      }
    }

    fetchResumen()
  }, [rutaId])

  // La fecha de hoy en Colombia sale de `todayColombia()` (@/lib/gestion-core):
  // una sola definicion para toda la app.

  // Consultar estado de la ruta diaria al montar / cambiar rutaId.
  //
  // SELECT directo sobre `rutas_diarias` filtrando por ruta_id y fecha.
  // (RLS eliminado.)
  useEffect(() => {
    const fetchRutaDiaria = async () => {
      try {
        setLoadingRutaDiaria(true)
        const supabase = createClient()
        const fechaHoy = todayColombia()

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
      const fechaHoy = todayColombia()

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

      // Ventana del dia de hoy en zona Colombia (inicio y fin).
      const fechaHoy = todayColombia()
      // El offset -05:00 es obligatorio: sin el, Postgres interpreta la
      // ventana en UTC y se pierde todo lo registrado despues de las 7 pm
      // hora Colombia.
      const startOfDay = `${fechaHoy}T00:00:00-05:00`
      const endOfDay = `${fechaHoy}T23:59:59-05:00`

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

  // ── Tarjeta trasera (Informe Recaudo): datos reales ─────────────────────
  // Frecuencias desde las cuotas del dia + loans.frecuencia_pago; "Intereses"
  // = prestamos americanos con cuota hoy. Cartera desde `v_loan_financiero`
  // (columna `cuotas_mora`: CUOTAS vencidas sin cubrir, no dias) con las
  // bandas de `bandaCartera()`. Cuotas por cliente = cuotas vencidas
  // pendientes (0-3 / >3). Ventas: renovacion = cliente que ya tenia otro
  // prestamo.
  const [backCard, setBackCard] = useState({
    frequency: {
      diario: { pagos: 0, total: 0 },
      semanal: { pagos: 0, total: 0 },
      quincenal: { pagos: 0, total: 0 },
      mensual: { pagos: 0, total: 0 },
      intereses: { pagos: 0, total: 0 },
    },
    installmentsByClient: { small: 0, large: 0 },
    salesReport: { nuevas: 0, renovaciones: 0, total: 0 },
    portfolioStatus: { alDia: 0, mora: 0, vencidos: 0 },
  })

  // Los préstamos que componen cada contador de la cara trasera, para poder
  // abrir "quiénes son". Se llenan en el MISMO recorrido que calcula los
  // números (ver `loadBackCard`).
  const [backIds, setBackIds] = useState<{
    freq: Record<string, string[]>
    pagaronHoy: Set<string>
    cuotas: { small: string[]; large: string[] }
    ventas: { nuevas: string[]; renovaciones: string[]; total: string[] }
    cartera: { alDia: string[]; mora: string[]; vencidos: string[] }
  }>({
    freq: { diario: [], semanal: [], quincenal: [], mensual: [], intereses: [] },
    pagaronHoy: new Set(),
    cuotas: { small: [], large: [] },
    ventas: { nuevas: [], renovaciones: [], total: [] },
    cartera: { alDia: [], mora: [], vencidos: [] },
  })

  // El detalle de personas que está abierto. `null` = ninguno.
  const [detalleClientes, setDetalleClientes] = useState<{
    titulo: string
    subtitulo?: string
    ids: string[]
    marcados?: Set<string>
    mostrarValorVenta?: boolean
  } | null>(null)

  const abrirDetalle = (
    titulo: string,
    ids: string[],
    extra?: { subtitulo?: string; marcados?: Set<string>; mostrarValorVenta?: boolean },
  ) => setDetalleClientes({ titulo, ids, ...extra })

  /**
   * Los dos ítems del Resumen Financiero que son personas —Canceladas y
   * Ventas— no se calculan en esta pantalla: vienen ya sumados de
   * `resumen_diario_v2`. Así que sus préstamos se resuelven al abrir el
   * ojito, repitiendo el MISMO criterio de la vista para que la lista
   * coincida con el monto.
   */
  const abrirDetalleFinanciero = async (cual: "canceladas" | "ventas") => {
    try {
      const supabase = createClient()
      const hoy = todayColombia()

      if (cual === "ventas") {
        const { data } = await supabase
          .from("loans")
          .select("id")
          .eq("ruta", rutaId)
          .gte("fecha_creacion", `${hoy}T00:00:00-05:00`)
          .lte("fecha_creacion", `${hoy}T23:59:59-05:00`)
        const ids = ((data ?? []) as { id: string }[]).map((l) => l.id)
        abrirDetalle("Ventas de hoy", ids, {
          subtitulo: `${ids.length} ${ids.length === 1 ? "venta" : "ventas"}`,
          mostrarValorVenta: true,
        })
        return
      }

      // Canceladas = préstamos cuyo ÚLTIMO movimiento de plata fue hoy y que
      // quedaron en cero. Es la definición de la vista (script 054).
      const { data: movs } = await supabase
        .from("gestiones")
        .select("loan_id")
        .eq("ruta", rutaId)
        .eq("fecha_gestion", hoy)
        .eq("estado", "aplicada")
        .neq("origen", "homologacion")
        .in("tipo", ["pago", "cancelacion", "abono_venta", "reversa"])
      const candidatos = [...new Set(((movs ?? []) as { loan_id: string }[]).map((g) => g.loan_id))]
      if (candidatos.length === 0) {
        abrirDetalle("Créditos cancelados hoy", [], { subtitulo: "Ninguno" })
        return
      }
      const { data: fin } = await supabase
        .from("v_loan_financiero")
        .select("loan_id, saldo")
        .in("loan_id", candidatos)
      const ids = ((fin ?? []) as { loan_id: string; saldo: number | null }[])
        .filter((f) => Number(f.saldo ?? 0) <= 0)
        .map((f) => f.loan_id)
      abrirDetalle("Créditos cancelados hoy", ids, {
        subtitulo: `${ids.length} ${ids.length === 1 ? "crédito quedó" : "créditos quedaron"} en cero`,
      })
    } catch (err) {
      console.error("[v0] abrirDetalleFinanciero:", err)
    }
  }

  /** El ojito. Se apaga solo cuando el grupo está vacío. */
  const Ojito = ({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) => (
    <Button
      variant="ghost"
      size="icon"
      className="h-4 w-4 p-0 shrink-0"
      title="Ver quiénes son"
      aria-label="Ver quiénes son"
      onClick={onClick}
      disabled={disabled}
    >
      <Eye className={`h-3 w-3 ${disabled ? "text-muted-foreground/30" : "text-muted-foreground"}`} />
    </Button>
  )

  useEffect(() => {
    const loadBackCard = async () => {
      try {
        const supabase = createClient()
        const fechaHoy = todayColombia()

        const [rowsHoyRes, activosRes, ventasHoyRes] = await Promise.all([
          supabase
            .from("payment_plan")
            .select("loan_id, estado, monto_pagado, loans(frecuencia_pago, tipo_amortizacion)")
            .eq("ruta", rutaId)
            .eq("fecha_pago", fechaHoy),
          supabase.from("loans").select("id").eq("ruta", rutaId).eq("estado", "activo"),
          supabase
            .from("loans")
            .select("id, client_id")
            .eq("ruta", rutaId)
            .gte("fecha_creacion", `${fechaHoy}T00:00:00-05:00`)
            .lte("fecha_creacion", `${fechaHoy}T23:59:59-05:00`),
        ])

        const rowsHoy = (rowsHoyRes.data ?? []) as {
          loan_id: string
          estado: string
          monto_pagado: number | null
          loans: { frecuencia_pago: string | null; tipo_amortizacion: string | null } | null
        }[]
        // OJO: este predicado NO es el `esPagoReal` de @/lib/gestion-core.
        // Aquel evalua una GESTION ({tipo, monto, estado}); aqui las filas son
        // CUOTAS de payment_plan, cuyo `estado` es el cache de la cascada. Se
        // deja local a proposito para no forzar dos cosas distintas en el
        // mismo nombre: este cuadro cuenta cuotas del cronograma, no eventos.
        const cuotaConPago = (row: { estado: string; monto_pagado: number | null }) =>
          ["pagado", "parcial", "cancelada"].includes(row.estado) && Number(row.monto_pagado ?? 0) > 0
        const frequency = {
          diario: { pagos: 0, total: 0 },
          semanal: { pagos: 0, total: 0 },
          quincenal: { pagos: 0, total: 0 },
          mensual: { pagos: 0, total: 0 },
          intereses: { pagos: 0, total: 0 },
        }
        // Los préstamos que componen cada número, recogidos en el MISMO
        // recorrido que lo calcula: así el ojito no puede mostrar una lista
        // distinta del contador que abrió.
        const idsFreq: Record<string, string[]> = {
          diario: [], semanal: [], quincenal: [], mensual: [], intereses: [],
        }
        const idsPagaronHoy = new Set<string>()
        for (const row of rowsHoy) {
          // El mapeo frecuencia -> etiqueta vive en gestion-core (FRECUENCIAS).
          const key = etiquetaFrecuencia(row.loans?.frecuencia_pago).toLowerCase() as
            "diario" | "semanal" | "quincenal" | "mensual"
          frequency[key].total += 1
          idsFreq[key].push(row.loan_id)
          if (cuotaConPago(row)) { frequency[key].pagos += 1; idsPagaronHoy.add(row.loan_id) }
          if (row.loans?.tipo_amortizacion?.toLowerCase().trim() === "americano") {
            frequency.intereses.total += 1
            idsFreq.intereses.push(row.loan_id)
            if (cuotaConPago(row)) frequency.intereses.pagos += 1
          }
        }

        // Cartera + cuotas vencidas por cliente (prestamos activos de la ruta)
        const loanIds = ((activosRes.data ?? []) as { id: string }[]).map((l) => l.id)
        const installmentsByClient = { small: 0, large: 0 }
        const portfolioStatus = { alDia: 0, mora: 0, vencidos: 0 }
        const idsCuotas = { small: [] as string[], large: [] as string[] }
        const idsCartera = { alDia: [] as string[], mora: [] as string[], vencidos: [] as string[] }
        if (loanIds.length > 0) {
          const [vencidasRes, moraRes] = await Promise.all([
            // Cuotas vencidas: `fecha_pago` es el VENCIMIENTO inmutable del
            // cronograma, asi que pendiente + vencida antes de hoy sigue
            // siendo la definicion correcta.
            supabase
              .from("payment_plan")
              .select("loan_id")
              .eq("estado", "pendiente")
              .lt("fecha_pago", fechaHoy)
              .in("loan_id", loanIds),
            supabase.from("v_loan_financiero").select("loan_id, cuotas_mora").in("loan_id", loanIds),
          ])
          const vencidasPorLoan = new Map<string, number>()
          for (const v of (vencidasRes.data ?? []) as { loan_id: string }[]) {
            vencidasPorLoan.set(v.loan_id, (vencidasPorLoan.get(v.loan_id) ?? 0) + 1)
          }
          const moraPorLoan = new Map<string, number>()
          for (const m of (moraRes.data ?? []) as { loan_id: string; cuotas_mora: number | null }[]) {
            moraPorLoan.set(m.loan_id, Number(m.cuotas_mora ?? 0))
          }
          for (const id of loanIds) {
            if ((vencidasPorLoan.get(id) ?? 0) > 3) { installmentsByClient.large += 1; idsCuotas.large.push(id) }
            else { installmentsByClient.small += 1; idsCuotas.small.push(id) }
            // Las bandas las decide `bandaCartera()`, no una escalera local.
            const banda = bandaCartera(moraPorLoan.get(id) ?? 0)
            if (banda === "al_dia") { portfolioStatus.alDia += 1; idsCartera.alDia.push(id) }
            else if (banda === "mora") { portfolioStatus.mora += 1; idsCartera.mora.push(id) }
            else { portfolioStatus.vencidos += 1; idsCartera.vencidos.push(id) }
          }
        }

        // Ventas del dia: renovacion = el cliente ya tenia otro prestamo
        const ventasHoy = (ventasHoyRes.data ?? []) as { id: string; client_id: string }[]
        let nuevas = 0
        let renovaciones = 0
        const idsVentas = { nuevas: [] as string[], renovaciones: [] as string[] }
        if (ventasHoy.length > 0) {
          const clientIds = [...new Set(ventasHoy.map((v) => v.client_id))]
          const { data: prevLoans } = await supabase
            .from("loans")
            .select("id, client_id")
            .in("client_id", clientIds)
          const loansPorCliente = new Map<string, number>()
          for (const l of (prevLoans ?? []) as { id: string; client_id: string }[]) {
            loansPorCliente.set(l.client_id, (loansPorCliente.get(l.client_id) ?? 0) + 1)
          }
          for (const v of ventasHoy) {
            if ((loansPorCliente.get(v.client_id) ?? 1) > 1) { renovaciones += 1; idsVentas.renovaciones.push(v.id) }
            else { nuevas += 1; idsVentas.nuevas.push(v.id) }
          }
        }

        setBackCard({
          frequency,
          installmentsByClient,
          salesReport: { nuevas, renovaciones, total: ventasHoy.length },
          portfolioStatus,
        })
        setBackIds({
          freq: idsFreq,
          pagaronHoy: idsPagaronHoy,
          cuotas: idsCuotas,
          ventas: { ...idsVentas, total: ventasHoy.map((v) => v.id) },
          cartera: idsCartera,
        })
      } catch (err) {
        console.error("[v0] Error cargando informe recaudo:", err)
      }
    }

    loadBackCard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rutaId])

  const reportData = {
    totalPayments: cantidadPagos,
    totalPending: cantidadPagos + cantidadNoPagos,
    ...backCard,
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
  const alDiaPercent = totalPortfolio > 0 ? (reportData.portfolioStatus.alDia / totalPortfolio) * 100 : 0
  const moraPercent = totalPortfolio > 0 ? (reportData.portfolioStatus.mora / totalPortfolio) * 100 : 0

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
              {/* Barra de acciones. Los iconos van en pastilla blanca con el
                  icono a color: en ghost sobre el degradado de marca se
                  perdian contra el fondo y no se leian como botones.
                  Se quito el menu de 3 puntos, que no tenia onClick — no
                  hacia absolutamente nada al tocarlo. */}
              <div className="flex items-center gap-1.5">
                {/* Informe Recaudo, de primero. Barras tipo 📊: es el simbolo
                    universal de "informe" y se reconoce de un vistazo, mucho
                    mas que la flecha circular que habia antes (que se lee como
                    "deshacer") o que un documento con grafica, donde a este
                    tamaño las barras casi no se distinguen. */}
                <Button
                  size="icon"
                  className="h-10 w-10 rounded-full bg-white hover:bg-white/90 text-info shadow-sm shrink-0"
                  title="Ver el Informe de Recaudo"
                  aria-label="Ver el Informe de Recaudo"
                  onClick={() => setIsFlipped(true)}
                >
                  <ChartColumnBig className="h-[22px] w-[22px]" />
                </Button>

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

                {/* Cierre de Caja: el candado, en rojo y del mismo tamaño que
                    el del informe. El candado ya se entendia — el problema era
                    que iba diminuto y en ghost sobre el degradado, asi que no
                    se veia. El rojo dice "esto cierra el dia": es la accion mas
                    consecuente de la pantalla, cuadra la plata y deja al
                    vendedor sin poder registrar mas hasta mañana. */}
                <Button
                  size="icon"
                  className="h-10 w-10 rounded-full bg-white hover:bg-white/90 text-destructive shadow-sm shrink-0"
                  title="Cierre de Caja"
                  aria-label="Cierre de Caja"
                  onClick={() => onViewChange?.("cierre-caja")}
                >
                  <LockKeyhole className="h-[22px] w-[22px]" />
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
            {/* Dia sin movimiento: la caja viene del ultimo dia con registro */}
            {diaSinMovimiento && (
              <p className="text-[10px] text-muted-foreground px-0.5">
                Hoy no hay movimientos registrados. El efectivo es el que quedó el último día
                con registro.
              </p>
            )}

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
                  const items: { label: string; value: number; color: string; textColor: string; icon: React.ElementType; detailType?: "Ingreso" | "Gasto" | "Retiro"; detalleClientes?: "canceladas" | "ventas"; maxOverride?: number }[] = [
                    { label: "Canceladas", value: valorCanceladas, color: "bg-warning", textColor: "text-icon-check", icon: CheckCircle, detalleClientes: "canceladas", maxOverride: collectedAmount },
                    { label: "Ventas", value: valorVentas, color: "bg-info", textColor: "text-icon-sales", icon: ShoppingCart, detalleClientes: "ventas" },
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
                            {/* El ojo va a la IZQUIERDA del nombre y no al final
                                de la fila. Estaba pegado despues del monto, que
                                tenia ancho fijo: en movil una cifra grande se
                                desbordaba de su caja y se montaba encima del
                                ojo, tapandolo. Las filas sin detalle llevan un
                                hueco del mismo tamano para que los nombres
                                sigan alineados entre si. */}
                            {item.detailType || item.detalleClientes ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-4 w-4 p-0 shrink-0"
                                title={`Ver el detalle de ${item.label.toLowerCase()}`}
                                onClick={() =>
                                  item.detailType
                                    ? fetchDetailRecords(item.detailType)
                                    : void abrirDetalleFinanciero(item.detalleClientes!)
                                }
                              >
                                <Eye className="h-3 w-3 text-muted-foreground" />
                              </Button>
                            ) : (
                              <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                            )}
                            <span className="text-sm text-muted-foreground w-20 truncate">{item.label}</span>
                            <div className="flex-1 h-3.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full ${item.color} rounded-full transition-all`}
                                style={{ width: `${barPercent}%` }}
                              />
                            </div>
                            {/* min-w en vez de w: la cifra puede crecer sin
                                desbordarse, y con shrink-0 no la comprime la
                                barra. */}
                            <span className="text-sm font-bold text-foreground min-w-16 text-right tabular-nums whitespace-nowrap shrink-0">
                              ${item.value.toLocaleString()}
                            </span>
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
                
                {/* Tres casos, no dos. Sin meta (`metaAmount === 0`) caía en
                    la rama de "Faltan" y mostraba un número sin sentido:
                    no se puede incumplir una meta que no existe. */}
                {metaAmount <= 0 ? (
                  <p className="text-center text-base text-muted-foreground mt-0.5">
                    Sin meta para hoy
                  </p>
                ) : collectedAmount >= metaAmount ? (
                  <p className="text-center text-base font-bold text-success mt-0.5">
                    Superaste la meta del día
                  </p>
                ) : (
                  <p className="text-center text-base font-bold text-destructive mt-0.5">
                    Meta no superada por ${remaining.toLocaleString()}
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

                {/* ── Composición del recaudo del día ──────────────────
                    Dos mini-tarjetas con el porcentaje sobre el recaudo.
                    QUÉ muestran depende de cómo trabaje la unidad:

                    · Con UN SOLO método de interés, el desglose
                      Capital/Intereses es degenerado por construcción —
                      sale del `tipo_amortizacion` del préstamo, así que
                      una caja siempre marca $0 y la otra el total. En su
                      lugar se muestra la FORMA DE PAGO, que sí dice algo:
                      cuánto entró en efectivo y cuánto por transferencia.
                    · Con los dos métodos habilitados, el desglose de
                      siempre sí informa y se conserva. */}
                {(() => {
                  const totalRecaudo = collectedAmount
                  const par = unidadDeUnSoloMetodo
                    ? [
                        { label: "Efectivo", valor: pagoEfectivo },
                        { label: "Transferencia", valor: pagoTransferencia },
                      ]
                    : [
                        { label: "Capital", valor: pagoCapital },
                        { label: "Intereses", valor: pagoIntereses },
                      ]
                  return (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {par.map((c) => (
                        <div key={c.label} className="rounded-lg border border-border bg-card px-3 py-2">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-medium text-muted-foreground">{c.label}</span>
                            <span className="text-[10px] font-bold text-primary">
                              {(totalRecaudo > 0 ? (c.valor / totalRecaudo) * 100 : 0).toFixed(1)}%
                            </span>
                          </div>
                          <p className="text-base font-bold text-foreground mt-0.5 leading-tight">
                            ${c.valor.toLocaleString()}
                          </p>
                        </div>
                      ))}
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
                  {/* Las cinco filas son iguales salvo el ícono, así que se
                      recorren: el ojito se define una vez y no cinco. */}
                  <div className="space-y-0.5">
                    {([
                      { key: "diario",    label: "Diario",    Icono: CheckCircle,   tono: "text-success" },
                      { key: "semanal",   label: "Semanal",   Icono: CalendarDays,  tono: "text-icon-calendar" },
                      { key: "quincenal", label: "Quincenal", Icono: CalendarClock, tono: "text-icon-clock" },
                      { key: "mensual",   label: "Mensual",   Icono: CalendarRange, tono: "text-icon-withdrawal" },
                      { key: "intereses", label: "Intereses", Icono: Coins,         tono: "text-icon-wallet" },
                    ] as const).map(({ key, label, Icono, tono }) => {
                      const f = reportData.frequency[key]
                      const ids = backIds.freq[key] ?? []
                      return (
                        <div key={key} className="flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <Ojito
                              disabled={ids.length === 0}
                              onClick={() =>
                                abrirDetalle(`Frecuencia ${label.toLowerCase()}`, ids, {
                                  subtitulo: `${f.pagos} de ${f.total} ya pagaron hoy`,
                                  marcados: backIds.pagaronHoy,
                                })
                              }
                            />
                            <Icono className={`h-2.5 w-2.5 ${tono}`} />
                            <span className="text-xs text-muted-foreground">{label}:</span>
                          </div>
                          <span className="text-xs font-bold text-foreground">
                            {f.pagos}
                            <span className="text-muted-foreground font-normal">/{f.total}</span>
                          </span>
                        </div>
                      )
                    })}
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
                    {([
                      { key: "small", label: "De 0.1 - 3", Icono: PiggyBank, tono: "text-icon-sales",
                        n: reportData.installmentsByClient.small, ids: backIds.cuotas.small },
                      { key: "large", label: "Mayor a 3",  Icono: Coins,     tono: "text-icon-wallet",
                        n: reportData.installmentsByClient.large, ids: backIds.cuotas.large },
                    ] as const).map(({ key, label, Icono, tono, n, ids }) => (
                      <div key={key} className="flex items-center justify-between">
                        <div className="flex items-center gap-1">
                          <Ojito
                            disabled={ids.length === 0}
                            onClick={() =>
                              abrirDetalle(`Cuotas vencidas: ${label.toLowerCase()}`, [...ids], {
                                subtitulo: `${n} ${n === 1 ? "cliente" : "clientes"}`,
                              })
                            }
                          />
                          <Icono className={`h-2.5 w-2.5 ${tono}`} />
                          <span className="text-xs text-muted-foreground">{label}:</span>
                        </div>
                        <span className="text-xs font-bold text-foreground">{n}</span>
                      </div>
                    ))}
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
                {/* Las barras se escalan contra la más alta, igual que en el
                    Resumen Financiero. Antes eran `n * 20px` SIN TECHO dentro
                    de un contenedor de 56px: con 3 ventas la barra ya medía
                    60px y, como el contenedor alinea al fondo y no recortaba,
                    el excedente crecía hacia arriba y se montaba sobre el
                    título "Informe Ventas". */}
                {(() => {
                  const { nuevas, renovaciones } = reportData.salesReport
                  const tope = Math.max(nuevas, renovaciones, 1)
                  // 44px de los 56 del contenedor: los 12 restantes son el
                  // número que va encima de cada barra.
                  const alto = (n: number) => `${Math.max((n / tope) * 44, 6)}px`
                  return (
                <div className="flex items-center justify-between">
                  <div className="flex items-end gap-3">
                    {/* Bar chart */}
                    <div className="flex items-end gap-2 h-14 overflow-hidden">
                      <div className="flex flex-col items-center">
                        <span className="text-xs font-bold text-info mb-1">{nuevas}</span>
                        <div className="w-8 bg-info rounded-t" style={{ height: alto(nuevas) }} />
                        <span className="text-[10px] text-muted-foreground mt-1">Nuevas</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-xs font-bold text-warning mb-1">{renovaciones}</span>
                        <div className="w-8 bg-warning rounded-t" style={{ height: alto(renovaciones) }} />
                        <span className="text-[10px] text-muted-foreground mt-1">Renov.</span>
                      </div>
                    </div>
                    {/* Los ojitos van al lado de las barras y no encima: ahí
                        arriba pelearían con el número por el mismo espacio. */}
                    <div className="flex flex-col gap-0.5 pb-4">
                      <div className="flex items-center gap-1">
                        <Ojito
                          disabled={nuevas === 0}
                          onClick={() => abrirDetalle("Ventas nuevas de hoy", backIds.ventas.nuevas, {
                            subtitulo: `${nuevas} ${nuevas === 1 ? "venta" : "ventas"}`,
                            mostrarValorVenta: true,
                          })}
                        />
                        <span className="text-[9px] text-muted-foreground">Nuevas</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Ojito
                          disabled={renovaciones === 0}
                          onClick={() => abrirDetalle("Renovaciones de hoy", backIds.ventas.renovaciones, {
                            subtitulo: `${renovaciones} ${renovaciones === 1 ? "renovación" : "renovaciones"}`,
                            mostrarValorVenta: true,
                          })}
                        />
                        <span className="text-[9px] text-muted-foreground">Renov.</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 border border-border rounded-lg p-2">
                    <Ojito
                      disabled={reportData.salesReport.total === 0}
                      onClick={() => abrirDetalle("Ventas de hoy", backIds.ventas.total, {
                        subtitulo: `${reportData.salesReport.total} en total`,
                        mostrarValorVenta: true,
                      })}
                    />
                    <CalendarDays className="h-5 w-5 text-icon-calendar" />
                    <span className="text-xl font-bold text-foreground">{reportData.salesReport.total}</span>
                  </div>
                </div>
                  )
                })()}
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
                    {([
                      { key: "alDia",    label: "Al Día",   punto: "bg-status-al-dia",  texto: "text-status-al-dia",
                        n: reportData.portfolioStatus.alDia,    ids: backIds.cartera.alDia },
                      { key: "mora",     label: "Mora",     punto: "bg-status-mora",    texto: "text-status-mora",
                        n: reportData.portfolioStatus.mora,     ids: backIds.cartera.mora },
                      { key: "vencidos", label: "Vencidos", punto: "bg-status-vencido", texto: "text-status-vencido",
                        n: reportData.portfolioStatus.vencidos, ids: backIds.cartera.vencidos },
                    ] as const).map(({ key, label, punto, texto, n, ids }) => (
                      <div key={key} className="flex items-center gap-2">
                        <Ojito
                          disabled={n === 0}
                          onClick={() =>
                            abrirDetalle(`Cartera — ${label.toLowerCase()}`, [...ids], {
                              subtitulo: `${n} de ${totalPortfolio} ${totalPortfolio === 1 ? "cliente" : "clientes"}`,
                            })
                          }
                        />
                        <div className={`h-3 w-3 rounded-full ${punto}`} />
                        <span className="text-xs text-muted-foreground">{label}</span>
                        <span className={`text-xs font-bold ${texto}`}>{n}</span>
                      </div>
                    ))}
                    {/* Total de la cartera: sin denominador, "12 en mora" no
                        dice si la ruta está mal o si tiene 300 clientes. */}
                    <div className="flex items-center gap-2 border-t pt-1.5">
                      <Ojito
                        disabled={totalPortfolio === 0}
                        onClick={() =>
                          abrirDetalle("Cartera completa", [
                            ...backIds.cartera.alDia,
                            ...backIds.cartera.mora,
                            ...backIds.cartera.vencidos,
                          ], { subtitulo: `${totalPortfolio} ${totalPortfolio === 1 ? "cliente" : "clientes"} con crédito activo` })
                        }
                      />
                      <div className="h-3 w-3" />
                      <span className="text-xs font-medium text-muted-foreground">Total</span>
                      <span className="text-xs font-bold text-foreground">{totalPortfolio}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Quiénes son las personas detrás de cada número.
          Va ACÁ, fuera del contenedor con `perspective`/`preserve-3d`: dentro
          de una cara de la tarjeta quedaría sometido a la rotación 3D y se
          vería espejado. */}
      <DetalleClientesDialog
        open={detalleClientes !== null}
        onOpenChange={(v) => { if (!v) setDetalleClientes(null) }}
        titulo={detalleClientes?.titulo ?? ""}
        subtitulo={detalleClientes?.subtitulo}
        loanIds={detalleClientes?.ids ?? []}
        marcados={detalleClientes?.marcados}
        mostrarValorVenta={detalleClientes?.mostrarValorVenta}
      />

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
