"use client"

/**
 * Los pagos del día, cliente por cliente.
 *
 * Se abre desde el ojito de "Pagos" en el Resumen del Día y muestra las
 * columnas que pidió Ivonne: nombre con apodo debajo, el pago en verde,
 * cuántas cuotas alcanzó a cubrir, si fue abono o canceló, el saldo, y un
 * segundo ojo con la venta completa y su historial.
 *
 * La lista sale del LIBRO, igual que el contador que la abre, así que el
 * número de filas no puede discrepar del "8 pagos" de la tarjeta.
 */

import { useEffect, useState } from "react"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ChevronLeft, Eye, Loader2 } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { fmtMoneda, fmtFecha, etiquetaFrecuencia } from "@/lib/gestion-core"
import {
  getPagosDelDia, getHistorialCredito,
  type PagoDelDiaRow, type HistorialCredito,
} from "@/lib/pagos-del-dia"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  rutaId: number
  fecha: string
}

/** "2,05" · "0,67" · "1" — sin decimales cuando es redondo. */
function fmtCuotas(n: number): string {
  if (!Number.isFinite(n)) return "—"
  const redondo = Math.abs(n - Math.round(n)) < 0.005
  return redondo
    ? String(Math.round(n))
    : n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function PagosDelDiaDialog({ open, onOpenChange, rutaId, fecha }: Props) {
  const [filas, setFilas] = useState<PagoDelDiaRow[]>([])
  const [cargando, setCargando] = useState(false)
  // Cuando hay un crédito abierto, el diálogo muestra su historial en vez de
  // la lista. Un solo diálogo con dos caras: en el teléfono, abrir otro
  // encima deja dos capas que hay que cerrar de a una.
  const [verHistorialDe, setVerHistorialDe] = useState<PagoDelDiaRow | null>(null)
  const [historial, setHistorial] = useState<HistorialCredito | null>(null)
  const [cargandoHistorial, setCargandoHistorial] = useState(false)

  useEffect(() => {
    if (!open) { setVerHistorialDe(null); setHistorial(null); return }
    let vigente = true
    setCargando(true)
    getPagosDelDia(createClient(), rutaId, fecha)
      .then((d) => { if (vigente) setFilas(d) })
      .finally(() => { if (vigente) setCargando(false) })
    return () => { vigente = false }
  }, [open, rutaId, fecha])

  useEffect(() => {
    if (!verHistorialDe) return
    let vigente = true
    setCargandoHistorial(true)
    setHistorial(null)
    getHistorialCredito(createClient(), verHistorialDe.loanId)
      .then((h) => { if (vigente) setHistorial(h) })
      .finally(() => { if (vigente) setCargandoHistorial(false) })
    return () => { vigente = false }
  }, [verHistorialDe])

  const totalPagado = filas.reduce((s, f) => s + f.pago, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto p-3 md:p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm md:text-base">
            {verHistorialDe && (
              <Button
                variant="ghost" size="icon" className="h-6 w-6"
                onClick={() => setVerHistorialDe(null)}
                aria-label="Volver a la lista"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            {verHistorialDe ? verHistorialDe.nombre : "Pagos del día"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {verHistorialDe
              ? "La venta completa y su historial de pagos"
              : `${filas.length} ${filas.length === 1 ? "cliente pagó" : "clientes pagaron"} · ${fmtMoneda(totalPagado)}`}
          </DialogDescription>
        </DialogHeader>

        {verHistorialDe ? (
          cargandoHistorial ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !historial ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No se pudo cargar el historial.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-border p-3 text-xs">
                {([
                  ["Venta", historial.fechaVenta ? fmtFecha(historial.fechaVenta) : "—"],
                  ["Prestado", fmtMoneda(historial.valorVenta)],
                  ["Total a pagar", fmtMoneda(historial.totalAPagar)],
                  ["Interés", `${historial.tasaInteres}%`],
                  ["Cuotas", `${historial.numeroCuotas} · ${etiquetaFrecuencia(historial.frecuencia)}`],
                  ["Tipo", historial.tipoAmortizacion ?? "—"],
                  ["Pagado", fmtMoneda(historial.totalPagado)],
                  ["Saldo", fmtMoneda(historial.saldo)],
                ] as const).map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">{k}:</span>
                    <span className="font-semibold text-foreground">{v}</span>
                  </div>
                ))}
              </div>

              <p className="text-xs font-semibold text-foreground">
                Historial de pagos ({historial.eventos.length})
              </p>
              <div className="divide-y divide-border rounded-xl border border-border">
                {historial.eventos.length === 0 ? (
                  <p className="p-3 text-center text-xs text-muted-foreground">Sin movimientos.</p>
                ) : (
                  historial.eventos.map((e, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 p-2 text-xs">
                      <div className="min-w-0">
                        <p className={`font-medium ${e.anulado ? "text-muted-foreground line-through" : "text-foreground"}`}>
                          {fmtFecha(e.fecha)} · {e.tipo}
                        </p>
                        {e.observacion && (
                          <p className="truncate text-[10px] text-muted-foreground">{e.observacion}</p>
                        )}
                      </div>
                      <span className={`shrink-0 font-semibold tabular-nums ${
                        e.anulado ? "text-muted-foreground line-through"
                          : e.tipo === "reversa" ? "text-destructive" : "text-success"
                      }`}>
                        {e.tipo === "reversa" ? "−" : ""}{fmtMoneda(e.monto)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        ) : cargando ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filas.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            Todavía no hay pagos registrados hoy en esta ruta.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium">Nombre / Apodo</th>
                  <th className="py-1.5 px-2 font-medium text-right">Pago</th>
                  <th className="py-1.5 px-2 font-medium text-center">Cuotas pagas</th>
                  <th className="py-1.5 px-2 font-medium text-center">Movimiento</th>
                  <th className="py-1.5 px-2 font-medium text-right">Saldo</th>
                  <th className="py-1.5 pl-2 font-medium text-center">Historial</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filas.map((f) => (
                  <tr key={f.loanId}>
                    <td className="py-2 pr-2">
                      <p className="font-semibold leading-tight text-foreground">{f.nombre}</p>
                      {f.apodo && f.apodo !== f.nombre && (
                        <p className="text-[10px] leading-tight text-muted-foreground">{f.apodo}</p>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {/* La píldora verde del mockup. Es el mismo formato que
                          ya usa el comprobante para el valor abonado. */}
                      <span className="inline-block rounded-full bg-success-light px-2 py-0.5 font-bold tabular-nums text-success">
                        {fmtMoneda(f.pago)}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-center font-semibold tabular-nums text-foreground">
                      {fmtCuotas(f.cuotasPagas)}
                    </td>
                    <td className={`px-2 py-2 text-center font-semibold ${
                      f.movimiento === "Cancelada" ? "text-destructive" : "text-muted-foreground"
                    }`}>
                      {f.movimiento}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-foreground">
                      {f.saldo > 0 ? fmtMoneda(f.saldo) : "—"}
                    </td>
                    <td className="py-2 pl-2 text-center">
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        onClick={() => setVerHistorialDe(f)}
                        aria-label={`Historial de ${f.nombre}`}
                        title="Ver la venta y su historial de pagos"
                      >
                        <Eye className="h-4 w-4 text-brand" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
