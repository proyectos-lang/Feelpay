"use client"

/**
 * La tabla de clientes con el formato que pidió Ivonne: nombre con apodo
 * debajo, la plata en una píldora verde, cuántas cuotas, el saldo, y un
 * segundo ojo con la venta completa y su historial.
 *
 * SIRVE PARA DOS OJITOS, con la misma tabla:
 *
 *   tipo "dia"       las visitas de un día en una ruta — los ojitos de "Pagos"
 *                    en el Resumen y en Monitoreo. Con `modo: "no_pagos"`
 *                    muestra el otro lado: a quién se visitó y no pagó. La
 *                    lista sale del LIBRO, igual que el contador que la abre,
 *                    así que el número de filas no puede discrepar del "8
 *                    pagos" de la tarjeta.
 *
 *   tipo "creditos"  un grupo de créditos — los ojitos de "Cuotas Clientes".
 *                    Ahí "Pago" es lo que el cliente lleva pagado del crédito
 *                    entero, no lo de hoy: en esa lista la mayoría no pagó
 *                    hoy y una columna de ceros no diría nada.
 *
 * SE COMPARTE EL COMPONENTE, NO SE COPIA. Dos tablas iguales son dos tablas
 * que se separan al primer arreglo que se haga en una sola.
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
  getPagosDelDia, getCreditosComoFilas, getHistorialCredito,
  type PagoDelDiaRow, type HistorialCredito, type ModoDia,
} from "@/lib/pagos-del-dia"

/** De dónde salen las filas. */
export type FuentePagos =
  | {
      tipo: "dia"
      rutaId: number
      fecha: string
      /**
       * Qué rebanada del día: 'pagos' (por defecto), 'no_pagos', o una de las
       * dos formas de pago — 'efectivo' / 'transferencia'.
       */
      modo?: ModoDia
      /** Encabezado propio. Sin esto dice "Pagos del día". */
      titulo?: string
    }
  | { tipo: "creditos"; loanIds: string[]; titulo: string }

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  /**
   * `null` mientras el diálogo está cerrado.
   *
   * OJO al cambiar esto: el efecto que carga los datos depende de este objeto.
   * Si el padre lo construye en línea (`fuente={{tipo:"dia", ...}}`), cada
   * render crea uno nuevo, el efecto se vuelve a disparar y la consulta entra
   * en bucle. Se guarda en un `useState` del padre justo por eso.
   */
  fuente: FuentePagos | null
}

/** "2,05" · "0,67" · "1" — sin decimales cuando es redondo. */
function fmtCuotas(n: number): string {
  if (!Number.isFinite(n)) return "—"
  const redondo = Math.abs(n - Math.round(n)) < 0.005
  return redondo
    ? String(Math.round(n))
    : n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function PagosDelDiaDialog({ open, onOpenChange, fuente }: Props) {
  const [filas, setFilas] = useState<PagoDelDiaRow[]>([])
  const [cargando, setCargando] = useState(false)
  // Cuando hay un crédito abierto, el diálogo muestra su historial en vez de
  // la lista. Un solo diálogo con dos caras: en el teléfono, abrir otro
  // encima deja dos capas que hay que cerrar de a una.
  const [verHistorialDe, setVerHistorialDe] = useState<PagoDelDiaRow | null>(null)
  const [historial, setHistorial] = useState<HistorialCredito | null>(null)
  const [cargandoHistorial, setCargandoHistorial] = useState(false)

  const porDia = fuente?.tipo === "dia"
  // Los no pagos no llevan plata ni cuotas: esas dos columnas se apagan.
  const soloNoPagos = fuente?.tipo === "dia" && fuente.modo === "no_pagos"
  // Efectivo / transferencia: la tabla es la misma, pero el pie tiene que
  // decir de qué está hablando. "3 clientes pagaron · $95.000" a secas, en la
  // lista del efectivo, se lee como si ese fuera TODO el recaudo del día.
  const formaDePago =
    fuente?.tipo === "dia" && (fuente.modo === "efectivo" || fuente.modo === "transferencia")
      ? fuente.modo
      : null

  useEffect(() => {
    if (!open || !fuente) { setVerHistorialDe(null); setHistorial(null); return }
    let vigente = true
    setCargando(true)
    const sb = createClient()
    const pedir =
      fuente.tipo === "dia"
        ? getPagosDelDia(sb, fuente.rutaId, fuente.fecha, fuente.modo ?? "pagos")
        : getCreditosComoFilas(sb, fuente.loanIds)
    pedir
      .then((d) => { if (vigente) setFilas(d) })
      .finally(() => { if (vigente) setCargando(false) })
    return () => { vigente = false }
  }, [open, fuente])

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
            {verHistorialDe
              ? verHistorialDe.nombre
              : fuente?.tipo === "dia"
                ? (fuente.titulo ?? (soloNoPagos ? "No pagos del día" : "Pagos del día"))
                : (fuente?.tipo === "creditos" ? fuente.titulo : "Clientes")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {verHistorialDe
              ? "La venta completa y su historial de pagos"
              : soloNoPagos
                ? `${filas.length} ${filas.length === 1 ? "cliente visitado que no pagó" : "clientes visitados que no pagaron"}`
                : formaDePago
                  ? `${filas.length} ${filas.length === 1 ? "cliente pagó" : "clientes pagaron"} por ${formaDePago === "efectivo" ? "efectivo" : "transferencia"} · ${fmtMoneda(totalPagado)}`
                  : porDia
                    ? `${filas.length} ${filas.length === 1 ? "cliente pagó" : "clientes pagaron"} · ${fmtMoneda(totalPagado)}`
                    : `${filas.length} ${filas.length === 1 ? "cliente" : "clientes"} · ${fmtMoneda(totalPagado)} pagado`}
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
            {soloNoPagos
              ? "Ese día no se registró ningún no pago en esta ruta."
              : porDia
                ? "Todavía no hay pagos registrados hoy en esta ruta."
                : "No hay clientes en este grupo."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium">Nombre / Apodo</th>
                  <th className="py-1.5 px-2 font-medium text-right">
                    {soloNoPagos ? "Cuota" : porDia ? "Pago" : "Pagado"}
                  </th>
                  {!soloNoPagos && (
                    <th className="py-1.5 px-2 font-medium text-center">Cuotas pagas</th>
                  )}
                  {/* "Movimiento" solo en el día. En un grupo de créditos
                      activos el saldo nunca es cero, así que las 139 filas
                      dirían "Abono": una columna entera repitiendo la misma
                      palabra. */}
                  {porDia && <th className="py-1.5 px-2 font-medium text-center">Movimiento</th>}
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
                      {/* La píldora verde del mockup — el mismo formato que ya
                          usa el comprobante para el valor abonado. En la lista
                          de no pagos no hay plata que mostrar, así que en su
                          lugar va la cuota que se dejó de cobrar. */}
                      {soloNoPagos ? (
                        <span className="tabular-nums text-muted-foreground">
                          {f.valorCuota > 0 ? fmtMoneda(f.valorCuota) : "—"}
                        </span>
                      ) : (
                        <>
                          <span className="inline-block rounded-full bg-success-light px-2 py-0.5 font-bold tabular-nums text-success">
                            {fmtMoneda(f.pago)}
                          </span>
                          {/* CÓMO pagó, debajo del cuánto.
                              Va acá y no en una columna propia: en el teléfono
                              la tabla ya lleva cinco, y una sexta obligaría a
                              arrastrar de lado para leer un dato de una sola
                              palabra. Debajo del monto se lee sin moverse, que
                              es donde uno ya está mirando.

                              Solo sale en la lista GENERAL de pagos: en las
                              que ya vienen filtradas por método repetiría el
                              título en cada fila. */}
                          {f.formaPago && (
                            <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                              {f.formaPago}
                            </p>
                          )}
                        </>
                      )}
                    </td>
                    {!soloNoPagos && (
                    <td className="px-2 py-2 text-center font-semibold tabular-nums text-foreground">
                      {fmtCuotas(f.cuotasPagas)}
                      {/* En el grupo se agrega "de N": ahí la gracia es ver
                          qué tan avanzado va cada crédito, no solo cuántas
                          cuotas lleva. */}
                      {!porDia && f.cuotasTotales > 0 && (
                        <span className="ml-1 font-normal text-muted-foreground">
                          de {f.cuotasTotales}
                        </span>
                      )}
                    </td>
                    )}
                    {porDia && (
                      <td className={`px-2 py-2 text-center font-semibold ${
                        f.movimiento === "Abono" ? "text-muted-foreground" : "text-destructive"
                      }`}>
                        {f.movimiento}
                      </td>
                    )}
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
