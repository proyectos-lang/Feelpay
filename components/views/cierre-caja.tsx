"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ArrowLeft, Calendar, Clock, Wallet, Banknote, Target, ShoppingCart,
  CheckCircle, Receipt, ArrowDownCircle, TrendingUp, CreditCard,
  CalendarDays, CalendarClock, PiggyBank, Coins, Users, AlertCircle, XCircle,
  FileDown, Lock, AlertTriangle, CheckCircle2, Loader2,
} from "lucide-react"
 import { createClient } from "@/lib/supabase/client"
import { todayColombia, bandaCartera, etiquetaFrecuencia } from "@/lib/gestion-core"
import { contarPendientes, suscribirCola } from "@/lib/offline-queue"

interface CierreCajaProps {
  onBack: () => void
  rutaId?: number
  rutaNombre?: string
  /**
   * Avisa al contenedor que la jornada quedó cerrada. Sin esto el estado de
   * `rutas_diarias` que tiene la app arriba se queda en "abierta" hasta la
   * siguiente recarga, y el bloqueo del vendedor no entraba en vigor sino
   * hasta que cerraba y volvía a abrir la app.
   */
  onRouteStateChange?: (estado: "abierta" | "cerrada" | null) => void
}

export function CierreCaja({ onBack, rutaId = 1, rutaNombre = "", onRouteStateChange }: CierreCajaProps) {
  const _now = new Date()
  const fecha = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric" }).format(_now)
  const hora = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "numeric", minute: "2-digit", hour12: true }).format(_now)

  // Estado real de la validación
  const [pagosPendientes, setPagosPendientes] = useState<number>(0)
  const [loadingPagos, setLoadingPagos] = useState<boolean>(true)

  // Operaciones pendientes (aún mock hasta que se conecte la lógica real)
  const operacionesPendientes: { tipo: string; monto: number; estado: string }[] = []

  // La fecha de hoy en Colombia sale de `todayColombia()` (@/lib/gestion-core):
  // una sola definicion para toda la app.

  // Consultar payment_plan para contar cuántos pagos del día siguen en estado "pendiente"
  useEffect(() => {
    const fetchPendientes = async () => {
      try {
        setLoadingPagos(true)
        const supabase = createClient()
        const fechaHoy = todayColombia()
        const { count, error } = await supabase
          .from("payment_plan")
          .select("*", { count: "exact", head: true })
          .eq("ruta", rutaId)
          .eq("fecha_pago", fechaHoy)
          .eq("estado", "pendiente")

        if (error) {
          console.error("[v0] Error fetching pagos pendientes:", error.message)
          setPagosPendientes(0)
        } else {
          setPagosPendientes(count ?? 0)
        }
      } catch (err) {
        console.error("[v0] Unexpected error fetching pagos pendientes:", err)
        setPagosPendientes(0)
      } finally {
        setLoadingPagos(false)
      }
    }

    fetchPendientes()
  }, [rutaId])

  // Operaciones capturadas sin conexion que aun no llegan al servidor. El
  // cierre suma TODO el dia, asi que con pendientes en cola los totales
  // estarian incompletos: no se puede cerrar hasta que la cola drene.
  const [sinSincronizar, setSinSincronizar] = useState(0)
  useEffect(() => {
    const leer = () => { void contarPendientes().then(setSinSincronizar).catch(() => {}) }
    leer()
    return suscribirCola(leer)
  }, [])

  const pagosCumple = pagosPendientes === 0
  const operacionesCumple = operacionesPendientes.length === 0
  const colaCumple = sinSincronizar === 0
  const puedesCerrar = pagosCumple && operacionesCumple && colaCumple && !loadingPagos

  // ── Datos reales del cierre ────────────────────────────────────────────
  // Fuentes: resumen_diario_v2 (misma vista que Resumen del Día — los números
  // coinciden entre ambas pantallas por construcción, incluida la Caja
  // Anterior, que ahora es una columna), payment_plan (conteos del día y
  // cuotas vencidas) y v_loan_financiero (cartera, por CUOTAS en mora, con
  // las bandas de `bandaCartera()`).
  type FrecKey = "diario" | "semanal" | "quincenal" | "mensual"
  const [cierreData, setCierreData] = useState({
    cajaAnterior: 0,
    efectivoFinal: 0,
    recaudo: { total: 0, meta: 0 },
    canceladas: { valor: 0, cantidad: 0 },
    ventas: { total: 0, cantidad: 0 },
    gastos: { valor: 0, cantidad: 0 },
    retiros: { valor: 0, cantidad: 0 },
    ingresos: { valor: 0, cantidad: 0 },
    pagos: { realizados: 0, total: 0 },
    frecuencia: {
      diario: { pagos: 0, total: 0 },
      semanal: { pagos: 0, total: 0 },
      quincenal: { pagos: 0, total: 0 },
      mensual: { pagos: 0, total: 0 },
    } as Record<FrecKey, { pagos: number; total: number }>,
    cuotas: { de0a3: 0, de3oMas: 0 },
    cartera: { alDia: 0, mora: 0, vencidos: 0 },
  })

  useEffect(() => {
    const loadCierreData = async () => {
      try {
        const supabase = createClient()
        const fechaHoy = todayColombia()

        const [resumenRes, rowsHoyRes, loansRes] = await Promise.all([
          supabase
            .from("resumen_diario_v2")
            .select(
              "valor_pago, meta_pagos, valor_ingresos, cantidad_ingresos, valor_gastos, cantidad_gastos, valor_retiros, cantidad_retiros, valor_canceladas, cantidad_canceladas, valor_ventas, cantidad_ventas, efectivo, caja_anterior",
            )
            .eq("fecha_pago", fechaHoy)
            .eq("ruta", rutaId)
            .maybeSingle(),
          supabase
            .from("payment_plan")
            .select("estado, monto_pagado, loans(frecuencia_pago)")
            .eq("ruta", rutaId)
            .eq("fecha_pago", fechaHoy),
          supabase.from("loans").select("id").eq("ruta", rutaId).eq("estado", "activo"),
        ])

        const r = (resumenRes.data ?? {}) as Record<string, number | null>
        const valorPago = Number(r.valor_pago ?? 0)
        const valorIngresos = Number(r.valor_ingresos ?? 0)
        const valorGastos = Number(r.valor_gastos ?? 0)
        const valorRetiros = Number(r.valor_retiros ?? 0)
        const valorVentas = Number(r.valor_ventas ?? 0)
        const efectivo = Number(r.efectivo ?? 0)
        // Caja Anterior: columna de la vista.
        // POR QUE se quitó la aritmética local (`efectivo` menos el neto del
        // día): había DOS fórmulas distintas para el mismo número — esta y la
        // consulta del día anterior de daily-summary — y divergían cuando
        // hubo días sin movimiento o cuando se editó un día pasado.
        const cajaAnterior = Number(r.caja_anterior ?? 0)

        const rowsHoy = (rowsHoyRes.data ?? []) as {
          estado: string
          monto_pagado: number | null
          loans: { frecuencia_pago: string | null } | null
        }[]
        // OJO: este predicado NO es el `esPagoReal` de @/lib/gestion-core.
        // Aquel evalúa una GESTIÓN ({tipo, monto, estado}); aquí las filas son
        // CUOTAS de payment_plan, cuyo `estado` es el cache de la cascada. Se
        // deja local a propósito: este bloque cuenta cuotas del cronograma
        // (cuántas de las que vencían hoy se tocaron), no eventos del libro.
        const cuotaConPago = (row: { estado: string; monto_pagado: number | null }) =>
          ["pagado", "parcial", "cancelada"].includes(row.estado) && Number(row.monto_pagado ?? 0) > 0
        const frecuencia: Record<FrecKey, { pagos: number; total: number }> = {
          diario: { pagos: 0, total: 0 },
          semanal: { pagos: 0, total: 0 },
          quincenal: { pagos: 0, total: 0 },
          mensual: { pagos: 0, total: 0 },
        }
        for (const row of rowsHoy) {
          // El mapeo frecuencia -> etiqueta vive en gestion-core (FRECUENCIAS):
          // estaba copiado tal cual en daily-summary y aquí.
          const key = etiquetaFrecuencia(row.loans?.frecuencia_pago).toLowerCase() as FrecKey
          frecuencia[key].total += 1
          if (cuotaConPago(row)) frecuencia[key].pagos += 1
        }

        const loanIds = ((loansRes.data ?? []) as { id: string }[]).map((l) => l.id)
        let cuotas = { de0a3: 0, de3oMas: 0 }
        let cartera = { alDia: 0, mora: 0, vencidos: 0 }
        if (loanIds.length > 0) {
          const [vencidasRes, moraRes] = await Promise.all([
            // Cuotas vencidas: `fecha_pago` es el VENCIMIENTO inmutable del
            // cronograma, así que pendiente + vencida antes de hoy sigue
            // siendo la definición correcta.
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
          for (const id of loanIds) {
            if ((vencidasPorLoan.get(id) ?? 0) > 3) cuotas.de3oMas += 1
            else cuotas.de0a3 += 1
          }

          const moraPorLoan = new Map<string, number>()
          for (const m of (moraRes.data ?? []) as { loan_id: string; cuotas_mora: number | null }[]) {
            moraPorLoan.set(m.loan_id, Number(m.cuotas_mora ?? 0))
          }
          for (const id of loanIds) {
            // Las bandas las decide `bandaCartera()`, no una escalera local.
            const banda = bandaCartera(moraPorLoan.get(id) ?? 0)
            if (banda === "al_dia") cartera.alDia += 1
            else if (banda === "mora") cartera.mora += 1
            else cartera.vencidos += 1
          }
        }

        setCierreData({
          cajaAnterior,
          efectivoFinal: efectivo,
          recaudo: { total: valorPago, meta: Number(r.meta_pagos ?? 0) },
          canceladas: { valor: Number(r.valor_canceladas ?? 0), cantidad: Number(r.cantidad_canceladas ?? 0) },
          ventas: { total: valorVentas, cantidad: Number(r.cantidad_ventas ?? 0) },
          gastos: { valor: valorGastos, cantidad: Number(r.cantidad_gastos ?? 0) },
          retiros: { valor: valorRetiros, cantidad: Number(r.cantidad_retiros ?? 0) },
          ingresos: { valor: valorIngresos, cantidad: Number(r.cantidad_ingresos ?? 0) },
          pagos: { realizados: rowsHoy.filter(cuotaConPago).length, total: rowsHoy.length },
          frecuencia,
          cuotas,
          cartera,
        })
      } catch (err) {
        console.error("[v0] Error cargando datos del cierre de caja:", err)
      }
    }

    loadCierreData()
  }, [rutaId])

  const [cajaCerrada, setCajaCerrada] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [processingCierre, setProcessingCierre] = useState(false)
  const [cierreError, setCierreError] = useState<string | null>(null)

  const handleCerrarCaja = () => {
    if (!puedesCerrar) {
      setShowModal(true)
      return
    }
    setCierreError(null)
    setShowConfirm(true)
  }

  const confirmarCierre = async () => {
    if (processingCierre) return
    setProcessingCierre(true)
    setCierreError(null)
    try {
      const supabase = createClient()
      const fechaHoy = todayColombia()

      // Finalizar la jornada en rutas_diarias: estado=cerrada + hora_fin=now()
      const { error } = await supabase
        .from("rutas_diarias")
        .update({
          estado: "cerrada",
          hora_fin: new Date().toISOString(),
        })
        .eq("ruta_id", rutaId)
        .eq("fecha", fechaHoy)
        .eq("estado", "abierta")

      if (error) {
        console.error("[v0] Error finalizando jornada:", error.message)
        setCierreError("No se pudo finalizar la jornada. Intenta de nuevo.")
        return
      }

      setCajaCerrada(true)
      setShowConfirm(false)
      // La jornada quedó cerrada: para el vendedor el día se acabó y no puede
      // hacer más movimientos. Se avisa hacia arriba para que el bloqueo entre
      // en vigor de inmediato, sin esperar a que recargue la app.
      onRouteStateChange?.("cerrada")
    } catch (err) {
      console.error("[v0] Unexpected error finalizando jornada:", err)
      setCierreError("Ocurrió un error al cerrar la caja.")
    } finally {
      setProcessingCierre(false)
    }
  }

  const data = { estado: cajaCerrada ? "Cerrada" : "Abierta", ...cierreData }

  const paymentPct = data.pagos.total > 0 ? Math.round((data.pagos.realizados / data.pagos.total) * 100) : 0
  const rutaLabel = rutaNombre ? `Ruta ${rutaId} — ${rutaNombre}` : `Ruta ${rutaId}`

  const handlePDF = () => {
    const win = window.open("", "_blank")
    if (!win) {
      alert("Por favor permite las ventanas emergentes para generar el PDF.")
      return
    }

    const logoUrl = `${window.location.origin}/opad-logo.png`

    win.document.write(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <title>Cierre de Caja - ${fecha}</title>
  <style>
    @page { size: A4; margin: 15mm 25mm; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 14px; color: #111; background: white; }
    .wrapper { max-width: 520px; margin: 0 auto; }
    .top-bar { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
    .top-bar img { width: 64px; height: 64px; object-fit: contain; }
    .top-bar .brand { display: flex; flex-direction: column; justify-content: center; }
    .top-bar .brand-name { font-size: 20px; font-weight: bold; color: #0f766e; line-height: 1.1; }
    .top-bar .brand-sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .header { background: #0f766e; color: white; padding: 14px 18px; border-radius: 6px; margin-bottom: 16px; text-align: center; }
    .header h1 { font-size: 20px; font-weight: bold; margin-bottom: 4px; }
    .header .sub { font-size: 13px; opacity: 0.88; margin-bottom: 3px; }
    .header .meta { font-size: 13px; opacity: 0.88; }
    table { width: 100%; border-collapse: collapse; }
    .section td { background: #0f766e; color: white; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.06em; padding: 6px 10px; }
    .row td { padding: 7px 10px; border-bottom: 1px solid #f0f4f8; font-size: 14px; }
    .row .label { color: #374151; }
    .row .value { color: #111; font-weight: 600; text-align: right; white-space: nowrap; }
    .subrow td { background: #f8fafc; padding: 5px 10px 5px 26px; border-bottom: 1px solid #f0f4f8; font-size: 13px; }
    .subrow .label { color: #6b7280; }
    .subrow .value { color: #374151; font-weight: 500; text-align: right; }
    .print-btn { display: block; margin: 20px auto 0; padding: 10px 28px; background: #0f766e; color: white; border: none; border-radius: 6px; font-size: 15px; cursor: pointer; }
    @media print { .print-btn { display: none; } }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="top-bar">
    <img src="${logoUrl}" alt="Logo OPAD Prime" />
    <div class="brand">
      <span class="brand-name">OPAD Prime</span>
      <span class="brand-sub">Sistema de Gestión de Cartera</span>
    </div>
  </div>
  <div class="header">
    <h1>Cierre de Caja</h1>
    <div class="sub">${rutaLabel}</div>
    <div class="meta">${fecha} &nbsp; ${hora} &nbsp;&nbsp; Estado: ${data.estado}</div>
  </div>
  <table><tbody>
    <tr class="section"><td colspan="2">Caja</td></tr>
    <tr class="row"><td class="label">Caja Anterior</td><td class="value">$${data.cajaAnterior.toLocaleString()}</td></tr>
    <tr class="row"><td class="label">Efectivo Final</td><td class="value">$${data.efectivoFinal.toLocaleString()}</td></tr>
    <tr class="section"><td colspan="2">Recaudo</td></tr>
    <tr class="row"><td class="label">Total Recaudo</td><td class="value">$${data.recaudo.total.toLocaleString()} / $${data.recaudo.meta.toLocaleString()}</td></tr>
    <tr class="section"><td colspan="2">Operaciones</td></tr>
    <tr class="row"><td class="label">Canceladas</td><td class="value">$${data.canceladas.valor.toLocaleString()} (${data.canceladas.cantidad})</td></tr>
    <tr class="row"><td class="label">Total Ventas</td><td class="value">$${data.ventas.total.toLocaleString()} (${data.ventas.cantidad})</td></tr>
    <tr class="row"><td class="label">Gastos</td><td class="value">$${data.gastos.valor.toLocaleString()} (${data.gastos.cantidad})</td></tr>
    <tr class="row"><td class="label">Retiros</td><td class="value">$${data.retiros.valor.toLocaleString()} (${data.retiros.cantidad})</td></tr>
    <tr class="row"><td class="label">Ingresos</td><td class="value">$${data.ingresos.valor.toLocaleString()} (${data.ingresos.cantidad})</td></tr>
    <tr class="section"><td colspan="2">Pagos</td></tr>
    <tr class="row"><td class="label">Cant. Pagos</td><td class="value">${data.pagos.realizados} / ${data.pagos.total} (${paymentPct}%)</td></tr>
    <tr class="row"><td class="label">Frec. Pago Diario</td><td class="value">${data.frecuencia.diario.pagos}/${data.frecuencia.diario.total}</td></tr>
    <tr class="row"><td class="label">Frec. Pago Semanal</td><td class="value">${data.frecuencia.semanal.pagos}/${data.frecuencia.semanal.total}</td></tr>
    <tr class="row"><td class="label">Frec. Pago Quincenal</td><td class="value">${data.frecuencia.quincenal.pagos}/${data.frecuencia.quincenal.total}</td></tr>
    <tr class="row"><td class="label">Frec. Pago Mensual</td><td class="value">${data.frecuencia.mensual.pagos}/${data.frecuencia.mensual.total}</td></tr>
    <tr class="section"><td colspan="2">Cuotas Vencidas por Cliente</td></tr>
    <tr class="row"><td class="label">De 0 a 3 cuotas vencidas</td><td class="value">${data.cuotas.de0a3}</td></tr>
    <tr class="row"><td class="label">Más de 3 cuotas vencidas</td><td class="value">${data.cuotas.de3oMas}</td></tr>
    <tr class="section"><td colspan="2">Estado de Cartera</td></tr>
    <tr class="row"><td class="label">Clientes Al Día</td><td class="value">${data.cartera.alDia}</td></tr>
    <tr class="row"><td class="label">Clientes en Mora</td><td class="value">${data.cartera.mora}</td></tr>
    <tr class="row"><td class="label">Clientes Vencidos</td><td class="value">${data.cartera.vencidos}</td></tr>
  </tbody></table>
  <button class="print-btn" onclick="window.print()">Guardar / Imprimir PDF</button>
</div>
</body>
</html>`)
    win.document.close()
  }

  type RowItem =
    | { type: "section"; label: string }
    | { type: "row"; icon: React.ElementType; iconColor: string; label: string; value: string }
    | { type: "subrow"; label: string; value: string }

  const rows: RowItem[] = [
    { type: "section", label: "Caja" },
    { type: "row", icon: Wallet,          iconColor: "text-icon-wallet",     label: "Caja Anterior",         value: `$${data.cajaAnterior.toLocaleString()}` },
    { type: "row", icon: Banknote,        iconColor: "text-icon-cash",       label: "Efectivo Final",         value: `$${data.efectivoFinal.toLocaleString()}` },

    { type: "section", label: "Recaudo" },
    { type: "row", icon: Target,          iconColor: "text-icon-target",     label: "Total Recaudo",          value: `$${data.recaudo.total.toLocaleString()} / $${data.recaudo.meta.toLocaleString()}` },

    { type: "section", label: "Operaciones" },
    { type: "row", icon: CheckCircle,     iconColor: "text-icon-check",      label: "Canceladas",             value: `$${data.canceladas.valor.toLocaleString()} (${data.canceladas.cantidad})` },
    { type: "row", icon: ShoppingCart,    iconColor: "text-icon-sales",      label: "Total Ventas",           value: `$${data.ventas.total.toLocaleString()} (${data.ventas.cantidad})` },
    { type: "row", icon: Receipt,         iconColor: "text-icon-expense",    label: "Gastos",                 value: `$${data.gastos.valor.toLocaleString()} (${data.gastos.cantidad})` },
    { type: "row", icon: ArrowDownCircle, iconColor: "text-icon-withdrawal", label: "Retiros",                value: `$${data.retiros.valor.toLocaleString()} (${data.retiros.cantidad})` },
    { type: "row", icon: TrendingUp,      iconColor: "text-icon-income",     label: "Ingresos",               value: `$${data.ingresos.valor.toLocaleString()} (${data.ingresos.cantidad})` },

    { type: "section", label: "Pagos" },
    { type: "row", icon: CreditCard,      iconColor: "text-icon-payment",    label: "Cant. Pagos",            value: `${data.pagos.realizados} / ${data.pagos.total} (${paymentPct}%)` },
    { type: "row", icon: CalendarDays,    iconColor: "text-success",         label: "Frec. Pago Diario",      value: `${data.frecuencia.diario.pagos}/${data.frecuencia.diario.total}` },
    { type: "row", icon: CalendarDays,    iconColor: "text-icon-calendar",   label: "Frec. Pago Semanal",     value: `${data.frecuencia.semanal.pagos}/${data.frecuencia.semanal.total}` },
    { type: "row", icon: CalendarClock,   iconColor: "text-icon-clock",      label: "Frec. Pago Quincenal",   value: `${data.frecuencia.quincenal.pagos}/${data.frecuencia.quincenal.total}` },
    { type: "row", icon: Coins,           iconColor: "text-icon-wallet",     label: "Frec. Pago Mensual",     value: `${data.frecuencia.mensual.pagos}/${data.frecuencia.mensual.total}` },

    { type: "section", label: "Cuotas Vencidas por Cliente" },
    { type: "row", icon: PiggyBank,       iconColor: "text-icon-sales",      label: "De 0 a 3 cuotas vencidas", value: `${data.cuotas.de0a3}` },
    { type: "row", icon: Coins,           iconColor: "text-icon-wallet",     label: "Más de 3 cuotas vencidas", value: `${data.cuotas.de3oMas}` },

    { type: "section", label: "Estado de Cartera" },
    { type: "row", icon: Users,           iconColor: "text-status-al-dia",   label: "Clientes Al Día",        value: `${data.cartera.alDia}` },
    { type: "row", icon: AlertCircle,     iconColor: "text-status-mora",     label: "Clientes en Mora",       value: `${data.cartera.mora}` },
    { type: "row", icon: XCircle,         iconColor: "text-status-vencido",  label: "Clientes Vencidos",      value: `${data.cartera.vencidos}` },
  ]

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="bg-brand-gradient text-brand-foreground px-4 pt-4 pb-3 rounded-b-2xl shadow-lg shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="text-brand-foreground hover:bg-white/20 h-8 w-8" onClick={onBack}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold tracking-tight leading-tight">Cierre de Caja</h1>
              <p className="text-[11px] text-brand-foreground/80">
                {rutaNombre ? `Ruta ${rutaId} — ${rutaNombre}` : `Ruta ${rutaId}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={`border-0 text-xs bg-white ${cajaCerrada ? "text-destructive" : "text-success"}`}>
              {cajaCerrada ? "Cerrada" : "Abierta"}
            </Badge>
            {/* Pastilla blanca sólida y con texto, no un icono fantasma: sobre
                el degradado del encabezado un ghost se confundía con el fondo
                y el usuario no sabía que ahí había un botón. */}
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-full bg-white px-3 text-brand hover:bg-white/90 shadow-sm font-semibold"
              title="Descargar el PDF del cierre"
              onClick={handlePDF}
            >
              <FileDown className="h-4 w-4" />
              <span className="text-xs">PDF</span>
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm text-brand-foreground/90 pl-10">
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" />
            <span>{fecha}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            <span>{hora}</span>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-3 py-2">
        <div className="bg-card rounded-xl shadow-sm overflow-hidden">
          {rows.map((row, i) => {
            if (row.type === "section") {
              return (
                <div key={i} className="flex items-center px-3 py-1.5 bg-brand">
                  <span className="text-[13px] font-bold text-brand-foreground uppercase tracking-widest">{row.label}</span>
                </div>
              )
            }
            if (row.type === "subrow") {
              return (
                <div key={i} className="flex items-center justify-between px-3 py-1.5 pl-9 border-b border-border bg-muted/40">
                  <span className="text-[14px] text-muted-foreground">{row.label}</span>
                  <span className="text-[14px] font-medium text-foreground">{row.value}</span>
                </div>
              )
            }
            const Icon = row.icon
            return (
              <div key={i} className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border last:border-0">
                <Icon className={`h-4 w-4 ${row.iconColor} shrink-0`} />
                <span className="text-[15px] text-foreground/80 flex-1">{row.label}</span>
                <span className="text-[15px] font-semibold text-foreground">{row.value}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer — Cerrar Caja + PDF */}
      <div className="px-3 py-3 shrink-0 space-y-2">
        {cajaCerrada ? (
          <div className="flex items-center justify-center gap-2 bg-muted rounded-xl py-3">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Caja cerrada</span>
          </div>
        ) : (
          <Button
            className="w-full bg-brand hover:bg-brand-light text-brand-foreground font-semibold rounded-xl py-5 text-sm flex items-center gap-2"
            onClick={handleCerrarCaja}
          >
            <Lock className="h-4 w-4" />
            Cerrar Caja y Finalizar Jornada
          </Button>
        )}

        {/* El PDF tambien al pie, que es donde el usuario esta mirando cuando
            termina de cerrar. Con la caja ya cerrada pasa a ser LA accion que
            queda —el comprobante de la jornada— asi que se muestra solido; con
            la caja abierta va en secundario para no competir con el boton de
            cerrar. */}
        <Button
          variant={cajaCerrada ? "default" : "outline"}
          className={`w-full rounded-xl py-5 text-sm font-semibold flex items-center gap-2 ${
            cajaCerrada ? "bg-success hover:bg-success/90 text-success-foreground" : ""
          }`}
          onClick={handlePDF}
        >
          <FileDown className="h-4 w-4" />
          Descargar PDF del cierre
        </Button>
      </div>

      {/* Modal — Requisitos no cumplidos */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 px-3 pb-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="bg-amber-500 px-4 py-3 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-white" />
              <span className="text-sm font-bold text-white">No se puede cerrar la caja</span>
            </div>
            <div className="px-4 py-4 space-y-3">
              <p className="text-xs text-gray-500">Debes resolver los siguientes pendientes antes de cerrar:</p>

              {!pagosCumple && (
                <div className="flex items-start gap-2.5 bg-amber-50 rounded-lg p-3 border border-amber-100">
                  <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-amber-800">Pagos pendientes por procesar</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      Quedan <span className="font-bold">{pagosPendientes}</span> cobros del día sin marcar
                      como pagado o no pagado.
                    </p>
                  </div>
                </div>
              )}

              {!colaCumple && (
                <div className="flex items-start gap-2.5 bg-amber-50 rounded-lg p-3 border border-amber-100">
                  <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-amber-800">Operaciones sin sincronizar</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      Hay <span className="font-bold">{sinSincronizar}</span> operación
                      {sinSincronizar === 1 ? "" : "es"} registrada{sinSincronizar === 1 ? "" : "s"} sin
                      conexión que aún no llegan al servidor. Los totales del cierre estarían
                      incompletos. Conéctate a internet y espera a que terminen de enviarse.
                    </p>
                  </div>
                </div>
              )}

              {!operacionesCumple && (
                <div className="flex items-start gap-2.5 bg-red-50 rounded-lg p-3 border border-red-100">
                  <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-red-800">Operaciones sin aprobar</p>
                    <ul className="mt-1 space-y-0.5">
                      {operacionesPendientes.map((op, i) => (
                        <li key={i} className="text-xs text-red-700">
                          • {op.tipo} ${op.monto.toLocaleString()} — {op.estado}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
            <div className="px-4 pb-4">
              <Button
                className="w-full bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-sm"
                onClick={() => setShowModal(false)}
              >
                Entendido
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal — Confirmar cierre */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 px-3 pb-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="bg-teal-600 px-4 py-3 flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-white" />
              <span className="text-sm font-bold text-white">Confirmar cierre de caja</span>
            </div>
            <div className="px-4 py-4 space-y-2">
              <p className="text-sm text-gray-700">
                Al cerrar la caja también se <span className="font-semibold">finalizará la jornada</span> del día.
                ¿Deseas continuar?
              </p>
              <p className="text-xs text-gray-400">
                Esta acción registrará el cierre a las {hora} del {fecha}.
              </p>
              {cierreError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5">
                  <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700">{cierreError}</p>
                </div>
              )}
            </div>
            <div className="px-4 pb-4 flex gap-2">
              <Button
                variant="outline"
                className="flex-1 rounded-xl text-sm"
                onClick={() => setShowConfirm(false)}
                disabled={processingCierre}
              >
                Cancelar
              </Button>
              <Button
                className="flex-1 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-sm gap-1.5"
                onClick={confirmarCierre}
                disabled={processingCierre}
              >
                {processingCierre && <Loader2 className="h-4 w-4 animate-spin" />}
                {processingCierre ? "Cerrando..." : "Sí, cerrar caja"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
