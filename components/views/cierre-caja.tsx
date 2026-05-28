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

interface CierreCajaProps {
  onBack: () => void
  rutaId?: number
  rutaNombre?: string
}

export function CierreCaja({ onBack, rutaId = 1, rutaNombre = "" }: CierreCajaProps) {
  const nowColombia = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }))
  const fecha = nowColombia.toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" })
  const hora = nowColombia.toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit", hour12: true })

  // Estado real de la validación
  const [pagosPendientes, setPagosPendientes] = useState<number>(0)
  const [loadingPagos, setLoadingPagos] = useState<boolean>(true)

  // Operaciones pendientes (aún mock hasta que se conecte la lógica real)
  const operacionesPendientes: { tipo: string; monto: number; estado: string }[] = []

  // Helper: fecha de hoy en zona Colombia (YYYY-MM-DD)
  const getFechaHoyColombia = () => {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    return formatter.format(new Date())
  }

  // Consultar payment_plan para contar cuántos pagos del día siguen en estado "pendiente"
  useEffect(() => {
    const fetchPendientes = async () => {
      try {
        setLoadingPagos(true)
        const supabase = createClient()
        const fechaHoy = getFechaHoyColombia()
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

  const pagosCumple = pagosPendientes === 0
  const operacionesCumple = operacionesPendientes.length === 0
  const puedesCerrar = pagosCumple && operacionesCumple && !loadingPagos

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
      const fechaHoy = getFechaHoyColombia()

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
    } catch (err) {
      console.error("[v0] Unexpected error finalizando jornada:", err)
      setCierreError("Ocurrió un error al cerrar la caja.")
    } finally {
      setProcessingCierre(false)
    }
  }

  const data = {
    estado: cajaCerrada ? "Cerrada" : "Abierta",
    cajaAnterior: 0,
    efectivoFinal: 225,
    recaudo: { total: 800, meta: 1200, transferencia: 0, efectivo: 800 },
    canceladas: { valor: 150, cantidad: 2 },
    ventas: { total: 550, cantidad: 3, nuevas: 0, renovacion: { valor: 200, cantidad: 1 } },
    gastos: { valor: 25, cantidad: 1 },
    retiros: { valor: 200, cantidad: 1 },
    ingresos: { valor: 0, cantidad: 0 },
    pagos: { realizados: 35, total: 50 },
    frecuencia: { 
      diario: { pagos: 28, total: 35 }, 
      semanal: { pagos: 5, total: 8 }, 
      quincenal: { pagos: 2, total: 4 }, 
      intereses: { pagos: 0, total: 2 } 
    },
    cuotas: { de0a3: 12, de3oMas: 23 },
    cartera: { alDia: 22, mora: 18, vencidos: 10 },
  }

  const paymentPct = Math.round((data.pagos.realizados / data.pagos.total) * 100)
  const rutaLabel = rutaNombre ? `Ruta ${rutaId} — ${rutaNombre}` : `Ruta ${rutaId}`

  const handlePDF = () => {
    const win = window.open("", "_blank")
    if (!win) {
      alert("Por favor permite las ventanas emergentes para generar el PDF.")
      return
    }

    const logoUrl = "https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Logo%20Feelpay.PNG-AWKE6ZXt07dwSoLfebE424CCyTrrNt.png"

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
    <tr class="subrow"><td class="label">• Transferencia</td><td class="value">$${data.recaudo.transferencia.toLocaleString()}</td></tr>
    <tr class="subrow"><td class="label">• Efectivo</td><td class="value">$${data.recaudo.efectivo.toLocaleString()}</td></tr>
    <tr class="section"><td colspan="2">Operaciones</td></tr>
    <tr class="row"><td class="label">Canceladas</td><td class="value">$${data.canceladas.valor.toLocaleString()} (${data.canceladas.cantidad})</td></tr>
    <tr class="row"><td class="label">Total Ventas</td><td class="value">$${data.ventas.total.toLocaleString()} (${data.ventas.cantidad})</td></tr>
    <tr class="subrow"><td class="label">• Nuevas</td><td class="value">$${data.ventas.nuevas.toLocaleString()}</td></tr>
    <tr class="subrow"><td class="label">• Renovación</td><td class="value">$${data.ventas.renovacion.valor.toLocaleString()} (${data.ventas.renovacion.cantidad})</td></tr>
    <tr class="row"><td class="label">Gastos</td><td class="value">$${data.gastos.valor.toLocaleString()} (${data.gastos.cantidad})</td></tr>
    <tr class="row"><td class="label">Retiros</td><td class="value">$${data.retiros.valor.toLocaleString()} (${data.retiros.cantidad})</td></tr>
    <tr class="row"><td class="label">Ingresos</td><td class="value">$${data.ingresos.valor.toLocaleString()} (${data.ingresos.cantidad})</td></tr>
    <tr class="section"><td colspan="2">Pagos</td></tr>
    <tr class="row"><td class="label">Cant. Pagos</td><td class="value">${data.pagos.realizados} / ${data.pagos.total} (${paymentPct}%)</td></tr>
    <tr class="row"><td class="label">Frec. Pago Diario</td><td class="value">${data.frecuencia.diario.pagos}/${data.frecuencia.diario.total}</td></tr>
    <tr class="row"><td class="label">Frec. Pago Semanal</td><td class="value">${data.frecuencia.semanal.pagos}/${data.frecuencia.semanal.total}</td></tr>
    <tr class="row"><td class="label">Frec. Pago Quincenal</td><td class="value">${data.frecuencia.quincenal.pagos}/${data.frecuencia.quincenal.total}</td></tr>
    <tr class="row"><td class="label">Intereses</td><td class="value">${data.frecuencia.intereses.pagos}/${data.frecuencia.intereses.total}</td></tr>
    <tr class="section"><td colspan="2">Cuotas por Clientes</td></tr>
    <tr class="row"><td class="label">De 0 - 3 Cuotas Pagas</td><td class="value">${data.cuotas.de0a3}</td></tr>
    <tr class="row"><td class="label">De 3 Cuotas o más</td><td class="value">${data.cuotas.de3oMas}</td></tr>
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
    { type: "subrow",                                                         label: "• Transferencia",        value: `$${data.recaudo.transferencia.toLocaleString()}` },
    { type: "subrow",                                                         label: "• Efectivo",             value: `$${data.recaudo.efectivo.toLocaleString()}` },

    { type: "section", label: "Operaciones" },
    { type: "row", icon: CheckCircle,     iconColor: "text-icon-check",      label: "Canceladas",             value: `$${data.canceladas.valor.toLocaleString()} (${data.canceladas.cantidad})` },
    { type: "row", icon: ShoppingCart,    iconColor: "text-icon-sales",      label: "Total Ventas",           value: `$${data.ventas.total.toLocaleString()} (${data.ventas.cantidad})` },
    { type: "subrow",                                                         label: "• Nuevas",               value: `$${data.ventas.nuevas.toLocaleString()}` },
    { type: "subrow",                                                         label: "• Renovación",           value: `$${data.ventas.renovacion.valor.toLocaleString()} (${data.ventas.renovacion.cantidad})` },
    { type: "row", icon: Receipt,         iconColor: "text-icon-expense",    label: "Gastos",                 value: `$${data.gastos.valor.toLocaleString()} (${data.gastos.cantidad})` },
    { type: "row", icon: ArrowDownCircle, iconColor: "text-icon-withdrawal", label: "Retiros",                value: `$${data.retiros.valor.toLocaleString()} (${data.retiros.cantidad})` },
    { type: "row", icon: TrendingUp,      iconColor: "text-icon-income",     label: "Ingresos",               value: `$${data.ingresos.valor.toLocaleString()} (${data.ingresos.cantidad})` },

    { type: "section", label: "Pagos" },
    { type: "row", icon: CreditCard,      iconColor: "text-icon-payment",    label: "Cant. Pagos",            value: `${data.pagos.realizados} / ${data.pagos.total} (${paymentPct}%)` },
    { type: "row", icon: CalendarDays,    iconColor: "text-success",         label: "Frec. Pago Diario",      value: `${data.frecuencia.diario.pagos}/${data.frecuencia.diario.total}` },
    { type: "row", icon: CalendarDays,    iconColor: "text-icon-calendar",   label: "Frec. Pago Semanal",     value: `${data.frecuencia.semanal.pagos}/${data.frecuencia.semanal.total}` },
    { type: "row", icon: CalendarClock,   iconColor: "text-icon-clock",      label: "Frec. Pago Quincenal",   value: `${data.frecuencia.quincenal.pagos}/${data.frecuencia.quincenal.total}` },
    { type: "row", icon: Coins,           iconColor: "text-icon-wallet",     label: "Intereses",              value: `${data.frecuencia.intereses.pagos}/${data.frecuencia.intereses.total}` },

    { type: "section", label: "Cuotas por Clientes" },
    { type: "row", icon: PiggyBank,       iconColor: "text-icon-sales",      label: "De 0 - 3 Cuotas Pagas", value: `${data.cuotas.de0a3}` },
    { type: "row", icon: Coins,           iconColor: "text-icon-wallet",     label: "De 3 Cuotas o más",      value: `${data.cuotas.de3oMas}` },

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
            <Button
              variant="ghost"
              size="icon"
              className="text-brand-foreground hover:bg-white/20 h-8 w-8"
              title="Descargar PDF"
              onClick={handlePDF}
            >
              <FileDown className="h-5 w-5" />
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

      {/* Footer — Cerrar Caja */}
      <div className="px-3 py-3 shrink-0">
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
