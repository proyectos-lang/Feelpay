"use client"

/**
 * Auditoría de cierre — qué explica cada número del día.
 *
 * El Resumen del Día publica una docena de cifras. Cuando una no cuadra, hasta
 * hoy había dos salidas: creerle a la pantalla, o pedir un script. Esta
 * pestaña es la tercera: cada cifra se abre y muestra los renglones que la
 * componen, hasta el evento suelto con su hora y su firma.
 *
 * DOS COLUMNAS, A PROPÓSITO. Al lado de cada total va el que publica
 * `resumen_diario_v2` y el que este módulo recalcula desde los hechos crudos
 * (`lib/auditoria-cierre.ts`). Normalmente son idénticos. Cuando NO lo son,
 * esa diferencia es el hallazgo, y por eso se muestra en rojo en vez de
 * esconderse: una auditoría que tapa sus propias discrepancias no audita nada.
 *
 * TODO EN PESOS EXACTOS. Acá se usa `fmtMoneda`, nunca `fmtMonedaCien`: el
 * Resumen redondea de $100 en $100 para leerse de un vistazo, pero una
 * auditoría que redondea no puede explicar un descuadre de $50.
 *
 * Es de SOLO LECTURA. Para corregir están Control de Pagos y el editor de
 * secretaría.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react"
import { fmtMoneda, horaColombia, todayColombia } from "@/lib/gestion-core"
import {
  cargarAuditoriaCierre,
  type AuditoriaCierre as Datos,
  type EventoCierre,
  type FilaCliente,
} from "@/lib/auditoria-cierre"

/**
 * Plata con signo al frente: `−$97.500`, no `$-97.500`.
 *
 * En una auditoría los negativos son frecuentes —una reversa, un día que
 * cerró en rojo— y `$-97.500` se lee mal de un vistazo, que es justo lo que
 * esta pantalla no se puede permitir.
 */
function fmtConSigno(valor: number): string {
  const v = Math.round(Number(valor) || 0)
  return v < 0 ? `−${fmtMoneda(-v)}` : fmtMoneda(v)
}

const ESTILO_EVENTO: Record<string, { label: string; chip: string }> = {
  pago: { label: "Pago", chip: "bg-green-100 text-green-800 border-green-300" },
  abono_venta: { label: "Abono venta", chip: "bg-teal-100 text-teal-800 border-teal-300" },
  no_pago: { label: "No pago", chip: "bg-amber-100 text-amber-900 border-amber-300" },
  cancelacion: { label: "Cancelación", chip: "bg-blue-100 text-blue-800 border-blue-300" },
  reversa: { label: "Reversa", chip: "bg-red-100 text-red-800 border-red-300" },
  ajuste: { label: "Ajuste", chip: "bg-slate-100 text-slate-700 border-slate-300" },
  extension: { label: "Extensión", chip: "bg-violet-100 text-violet-800 border-violet-300" },
}

const ETIQUETA_ORIGEN: Record<string, string> = {
  campo: "Calle",
  ajuste: "Escritorio",
  venta: "Venta",
  secretaria: "Secretaría",
  homologacion: "Homologación",
}

/**
 * Una cifra del día con su fórmula y, si la hay, su diferencia.
 *
 * `vista` es lo que publica el resumen; `calculado` lo que sale de los hechos.
 * Cuando difieren se pintan las dos y se nombra la diferencia: es el único
 * momento en que esta pantalla grita.
 */
function Cifra({
  icono: Icono,
  label,
  calculado,
  vista,
  formula,
  detalle,
  tono,
  abierto,
  onToggle,
  children,
}: {
  icono: typeof Wallet
  label: string
  calculado: number
  vista: number | null
  formula: string
  detalle?: string
  tono?: string
  abierto?: boolean
  onToggle?: () => void
  children?: React.ReactNode
}) {
  const difiere = vista != null && Math.round(vista) !== Math.round(calculado)
  const clickable = !!onToggle

  return (
    <div
      className={`rounded-xl border ${
        difiere ? "border-red-400 bg-red-50/50" : "bg-card"
      }`}
    >
      <div
        className={`p-3 ${clickable ? "cursor-pointer select-none" : ""}`}
        onClick={onToggle}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={(e) => {
          if (clickable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault()
            onToggle?.()
          }
        }}
      >
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Icono className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          {clickable &&
            (abierto ? (
              <ChevronDown className="h-3.5 w-3.5 ml-auto shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 ml-auto shrink-0" />
            ))}
        </div>

        <div className={`mt-0.5 text-lg md:text-2xl font-bold tabular-nums ${tono ?? ""}`}>
          {fmtConSigno(calculado)}
        </div>

        {detalle && <div className="text-[11px] text-muted-foreground">{detalle}</div>}

        <div className="text-[10px] text-muted-foreground mt-1 leading-tight">{formula}</div>

        {difiere && (
          <div className="mt-1.5 rounded-md bg-red-100 border border-red-300 px-2 py-1 text-[10px] text-red-900 leading-tight">
            <span className="font-bold">No coincide con el resumen.</span> El resumen
            dice {fmtConSigno(vista ?? 0)} y los movimientos suman{" "}
            {fmtConSigno(calculado)}: una diferencia de{" "}
            {fmtConSigno(calculado - (vista ?? 0))}.
          </div>
        )}
      </div>

      {abierto && children && <div className="border-t px-3 py-2">{children}</div>}
    </div>
  )
}

/** Un evento del libro, crudo: tipo, monto, hora, quién y de dónde salió. */
function Evento({ ev }: { ev: EventoCierre }) {
  const estilo =
    ESTILO_EVENTO[ev.tipo] ?? { label: ev.tipo, chip: "bg-slate-100 text-slate-700 border-slate-300" }
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1 text-[11px] leading-tight">
      <span
        className={`inline-block rounded-full border px-1.5 py-0.5 font-semibold ${estilo.chip}`}
      >
        {estilo.label}
      </span>
      {ev.tipo !== "no_pago" && (
        <span
          className={`font-bold tabular-nums ${ev.aporte < 0 ? "text-red-600" : ""}`}
        >
          {ev.aporte < 0 ? "−" : ""}
          {fmtMoneda(Math.abs(ev.aporte))}
        </span>
      )}
      <span className="text-muted-foreground">{horaColombia(ev.fecha_hora)}</span>
      <span className="text-muted-foreground">
        · {ETIQUETA_ORIGEN[ev.origen] ?? ev.origen}
      </span>
      {ev.metodoEfectivo === "transferencia" && (
        <Badge className="bg-sky-100 text-sky-800 border-sky-300 text-[9px]">
          Transferencia
        </Badge>
      )}
      {ev.usuario && <span className="text-muted-foreground">· {ev.usuario}</span>}
      {ev.estado !== "aplicada" && (
        <Badge className="bg-amber-100 text-amber-900 border-amber-300 text-[9px]">
          {ev.estado === "en_revision" ? "En revisión" : "Rechazada"}
        </Badge>
      )}
      {ev.observacion && (
        <span className="w-full text-muted-foreground italic">{ev.observacion}</span>
      )}
    </div>
  )
}

/** Un cliente del día: el resultado, y debajo todo el rastro que lo produjo. */
function Cliente({ c }: { c: FilaCliente }) {
  const [abierto, setAbierto] = useState(false)
  return (
    <div className="border-b last:border-b-0 py-1.5">
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setAbierto((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            setAbierto((v) => !v)
          }
        }}
      >
        {abierto ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="text-xs font-medium truncate flex-1">{c.cliente}</span>

        {c.corregido && (
          <Badge className="bg-amber-100 text-amber-900 border-amber-300 text-[9px] shrink-0">
            {c.eventos.length} eventos
          </Badge>
        )}
        {c.estado === "no_pago" ? (
          <Badge className="bg-amber-100 text-amber-900 border-amber-300 text-[9px] shrink-0">
            No pago
          </Badge>
        ) : (
          <span className="text-xs font-bold tabular-nums shrink-0">
            {fmtConSigno(c.neto)}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-10 text-right">
          {horaColombia(c.hora)}
        </span>
      </div>

      {abierto && (
        <div className="pl-5 pt-1">
          {c.eventos.length > 1 && (
            <div className="text-[10px] text-muted-foreground mb-1">
              {c.eventos.length} eventos en el día. El neto es lo que quedó:{" "}
              {fmtMoneda(c.neto)}.
            </div>
          )}
          {c.eventos.map((ev) => (
            <Evento key={ev.id} ev={ev} />
          ))}
          {(c.transferencia !== 0 || c.netoCampo !== c.neto) && (
            <div className="text-[10px] text-muted-foreground mt-1 leading-tight">
              {c.netoCampo !== c.neto && (
                <>
                  De calle {fmtConSigno(c.netoCampo)} · de escritorio{" "}
                  {fmtConSigno(c.neto - c.netoCampo)}.{" "}
                </>
              )}
              {c.transferencia !== 0 && (
                <>
                  Efectivo {fmtConSigno(c.efectivo)} · transferencia{" "}
                  {fmtConSigno(c.transferencia)}.
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Vacio({ texto }: { texto: string }) {
  return <div className="py-3 text-center text-[11px] text-muted-foreground">{texto}</div>
}

interface Props {
  rutaId: number | "todas"
  rutas: { id: number; nombre: string }[]
  onRutaChange: (ruta: number | "todas") => void
}

export function AuditoriaCierrePanel({ rutaId, rutas, onRutaChange }: Props) {
  const [fecha, setFecha] = useState(todayColombia())
  const [datos, setDatos] = useState<Datos | null>(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [abierta, setAbierta] = useState<string | null>(null)
  const [busqueda, setBusqueda] = useState("")

  // `rutaId` puede venir "todas" desde secretaría, pero un cierre es SIEMPRE
  // de una ruta: no existe el cierre de todas juntas. Se resuelve a la primera
  // disponible en vez de mostrar un panel vacío sin explicar por qué.
  const ruta = rutaId === "todas" ? (rutas[0]?.id ?? null) : rutaId

  const cargar = useCallback(async () => {
    if (ruta == null) return
    setCargando(true)
    setError(null)
    try {
      setDatos(await cargarAuditoriaCierre(ruta, fecha))
    } catch (err) {
      console.error("[v0] auditoria de cierre:", err)
      setError(err instanceof Error ? err.message : "No se pudo cargar el día")
      setDatos(null)
    } finally {
      setCargando(false)
    }
  }, [ruta, fecha])

  useEffect(() => {
    cargar()
  }, [cargar])

  const alternar = (k: string) => setAbierta((a) => (a === k ? null : k))

  const filtrar = useCallback(
    (lista: FilaCliente[]) => {
      const t = busqueda.trim().toLowerCase()
      if (!t) return lista
      return lista.filter(
        (c) =>
          c.cliente.toLowerCase().includes(t) ||
          (c.documento ?? "").toLowerCase().includes(t),
      )
    },
    [busqueda],
  )

  const pagados = useMemo(
    () => filtrar((datos?.clientes ?? []).filter((c) => c.estado === "pagado")),
    [datos, filtrar],
  )
  const noPagados = useMemo(
    () => filtrar((datos?.clientes ?? []).filter((c) => c.estado === "no_pago")),
    [datos, filtrar],
  )

  const t = datos?.totales
  const v = datos?.resumen

  return (
    <div className="space-y-3">
      {/* ── Ruta y día ─────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-muted-foreground">Unidad</label>
              <Select
                value={ruta == null ? "" : String(ruta)}
                onValueChange={(val) => onRutaChange(Number(val))}
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Elija una unidad" />
                </SelectTrigger>
                <SelectContent>
                  {rutas.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)} className="text-xs">
                      {r.nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground">Día del cierre</label>
              <Input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
          </div>

          {datos?.jornada && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              <span>
                Jornada: <span className="font-medium">{datos.jornada.estado ?? "—"}</span>
              </span>
              {datos.jornada.hora_inicio && (
                <span>· abrió {horaColombia(datos.jornada.hora_inicio)}</span>
              )}
              {datos.jornada.hora_fin && (
                <span>· cerró {horaColombia(datos.jornada.hora_fin)}</span>
              )}
              {datos.jornada.aprobacion_admin && (
                <Badge className="bg-slate-100 text-slate-700 border-slate-300 text-[9px]">
                  {datos.jornada.aprobacion_admin}
                </Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {cargando && (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {error && !cargando && (
        <Card>
          <CardContent className="p-4 text-center space-y-2">
            <AlertTriangle className="h-5 w-5 mx-auto text-amber-600" />
            <p className="text-xs text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={cargar} className="text-xs">
              Reintentar
            </Button>
          </CardContent>
        </Card>
      )}

      {!cargando && !error && datos && t && (
        <>
          {/* Un día que nunca abrió no es un día en cero: es un día sin fila.
              Decirlo evita que alguien lea los ceros como "no recaudó nada". */}
          {!v && (
            <Card>
              <CardContent className="p-3 text-[11px] text-muted-foreground">
                Esta unidad no tiene resumen para ese día: nunca se abrió la jornada.
                Lo que se ve abajo son los movimientos que sí quedaron registrados
                con esa fecha, si los hay.
              </CardContent>
            </Card>
          )}

          {/* ── Buscador ─────────────────────────────────────────────────── */}
          {(datos.clientes.length > 0 || datos.cuotas.length > 0) && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar un cliente en el día…"
                className="h-9 pl-8 text-xs"
              />
            </div>
          )}

          {/* ── Recaudo ──────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Cifra
              icono={Banknote}
              label="Recaudo del día"
              calculado={t.valorPago}
              vista={v ? Number(v.valor_pago) : null}
              tono="text-green-700"
              detalle={`${t.cantidadPagos} pagaron · ${t.cantidadNoPagos} no pagaron`}
              formula="Suma de lo que quedó puesto por cada cliente: pagos, cancelaciones y abonos, menos las reversas."
              abierto={abierta === "pagos"}
              onToggle={() => alternar("pagos")}
            >
              {pagados.length === 0 ? (
                <Vacio texto="Nadie pagó ese día." />
              ) : (
                <>
                  <div className="text-[10px] text-muted-foreground mb-1">
                    {pagados.length} clientes. Toque uno para ver sus eventos.
                  </div>
                  {pagados.map((c) => (
                    <Cliente key={c.loanId} c={c} />
                  ))}
                </>
              )}
            </Cifra>

            <Cifra
              icono={Target}
              label="Debido cobrar (meta)"
              calculado={t.meta}
              vista={v ? Number(v.meta_pagos) : null}
              detalle={`${datos.cuotas.filter((c) => c.cuentaEnMeta).length} cuotas vencen ese día`}
              formula="Suma de las cuotas que vencen ese día. Un crédito ya cancelado deja de sumar al día siguiente de cancelarse."
              abierto={abierta === "meta"}
              onToggle={() => alternar("meta")}
            >
              {datos.cuotas.length === 0 ? (
                <Vacio texto="Ninguna cuota vencía ese día." />
              ) : (
                <>
                  {datos.cuotas.some((c) => !c.cuentaEnMeta) && (
                    <div className="text-[10px] text-muted-foreground mb-1">
                      Las tachadas son de créditos que ya estaban cancelados: su
                      cuota no entra en la meta.
                    </div>
                  )}
                  {datos.cuotas
                    .filter((c) => {
                      const q = busqueda.trim().toLowerCase()
                      return !q || c.cliente.toLowerCase().includes(q)
                    })
                    .map((c) => (
                      <div
                        key={`${c.loanId}-${c.numeroCuota}`}
                        className="flex items-center gap-2 border-b last:border-b-0 py-1 text-[11px]"
                      >
                        <span
                          className={`flex-1 truncate ${
                            c.cuentaEnMeta ? "" : "line-through text-muted-foreground"
                          }`}
                        >
                          {c.cliente}
                        </span>
                        {c.numeroCuota != null && (
                          <span className="text-muted-foreground shrink-0">
                            #{c.numeroCuota}
                          </span>
                        )}
                        <span className="tabular-nums font-medium shrink-0">
                          {fmtMoneda(c.valorCuota)}
                        </span>
                        <span className="text-muted-foreground shrink-0 w-16 text-right truncate">
                          {c.pagado > 0 ? fmtMoneda(c.pagado) : "—"}
                        </span>
                      </div>
                    ))}
                </>
              )}
            </Cifra>
          </div>

          {/* ── De dónde vino la plata ───────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Cifra
              icono={Banknote}
              label="De la calle"
              calculado={t.valorCampo}
              vista={v ? Number(v.valor_pago_campo) : null}
              formula="Eventos con origen 'campo': lo que el cobrador registró en la ruta."
            />
            <Cifra
              icono={Banknote}
              label="De escritorio"
              calculado={t.valorAjuste}
              vista={v ? Number(v.valor_pago_ajuste) : null}
              formula="Correcciones hechas desde secretaría o Control de Pagos."
            />
            <Cifra
              icono={Wallet}
              label="En efectivo"
              calculado={t.efectivoPagos}
              vista={v ? Number(v.pago_efectivo) : null}
              formula="Sin método anotado cuenta como efectivo. Una reversa hereda el método del pago que deshace."
            />
            <Cifra
              icono={Wallet}
              label="Por transferencia"
              calculado={t.transferenciaPagos}
              vista={v ? Number(v.pago_transferencia) : null}
              formula="Eventos marcados como transferencia."
            />
          </div>

          {/* ── No pagos ─────────────────────────────────────────────────── */}
          <Card>
            <CardContent className="p-3">
              <div
                className="flex items-center gap-1.5 cursor-pointer"
                onClick={() => alternar("nopagos")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    alternar("nopagos")
                  }
                }}
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                <span className="text-xs font-semibold">
                  No pagos del día ({t.cantidadNoPagos})
                </span>
                {abierta === "nopagos" ? (
                  <ChevronDown className="h-3.5 w-3.5 ml-auto" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                )}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                Clientes visitados que terminaron el día sin plata puesta.
              </div>
              {abierta === "nopagos" && (
                <div className="mt-2">
                  {noPagados.length === 0 ? (
                    <Vacio texto="No hubo no pagos ese día." />
                  ) : (
                    noPagados.map((c) => <Cliente key={c.loanId} c={c} />)
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Gastos, ingresos, retiros ────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {(
              [
                ["Gasto", "Gastos", t.gastos, v ? Number(v.valor_gastos) : null, TrendingDown, "text-red-700"],
                ["Ingreso", "Ingresos", t.ingresos, v ? Number(v.valor_ingresos) : null, TrendingUp, "text-green-700"],
                ["Retiro", "Retiros", t.retiros, v ? Number(v.valor_retiros) : null, Wallet, "text-blue-700"],
              ] as const
            ).map(([tipo, label, calc, vis, Icono, tono]) => {
              const propios = datos.movimientos.filter((m) => m.tipo === tipo)
              const fuera = propios.filter((m) => !m.cuenta)
              return (
                <Cifra
                  key={tipo}
                  icono={Icono}
                  label={label}
                  calculado={calc}
                  vista={vis}
                  tono={tono}
                  detalle={`${propios.filter((m) => m.cuenta).length} ${
                    propios.filter((m) => m.cuenta).length === 1
                      ? "registrado"
                      : "registrados"
                  }${fuera.length > 0 ? ` · ${fuera.length} sin aprobar` : ""}`}
                  formula="Solo cuentan los aprobados por secretaría o los que no necesitaban aprobación."
                  abierto={abierta === tipo}
                  onToggle={() => alternar(tipo)}
                >
                  {propios.length === 0 ? (
                    <Vacio texto={`Sin ${label.toLowerCase()} ese día.`} />
                  ) : (
                    propios.map((m) => (
                      <div
                        key={m.id}
                        className="border-b last:border-b-0 py-1 text-[11px] leading-tight"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`flex-1 truncate ${
                              m.cuenta ? "" : "line-through text-muted-foreground"
                            }`}
                          >
                            {m.concepto}
                          </span>
                          <span className="tabular-nums font-medium shrink-0">
                            {fmtMoneda(m.valor)}
                          </span>
                          <span className="text-muted-foreground shrink-0 w-10 text-right">
                            {horaColombia(m.fechahorasol)}
                          </span>
                        </div>
                        {!m.cuenta && (
                          <div className="text-[10px] text-amber-700">
                            No entra en el total: secretaría «{m.estadosecre}», admin «
                            {m.estadoadmin}».
                          </div>
                        )}
                        {m.observacion && (
                          <div className="text-[10px] text-muted-foreground italic truncate">
                            {m.observacion}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </Cifra>
              )
            })}
          </div>

          {/* ── Ventas y caja ────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Cifra
              icono={TrendingDown}
              label="Ventas que salieron de la caja"
              calculado={t.ventasCaja}
              vista={v ? Number(v.valor_ventas_caja) : null}
              detalle={`${datos.ventas.length} ventas · ${fmtMoneda(t.ventas)} en total`}
              formula="Capital prestado ese día. Las homologadas se muestran pero no descuentan: esa plata nunca salió de esta caja."
              abierto={abierta === "ventas"}
              onToggle={() => alternar("ventas")}
            >
              {datos.ventas.length === 0 ? (
                <Vacio texto="No se vendió ese día." />
              ) : (
                datos.ventas.map((ven) => (
                  <div
                    key={ven.id}
                    className="flex items-center gap-2 border-b last:border-b-0 py-1 text-[11px]"
                  >
                    <span
                      className={`flex-1 truncate ${
                        ven.homologada ? "line-through text-muted-foreground" : ""
                      }`}
                    >
                      {ven.cliente}
                    </span>
                    {ven.homologada && (
                      <Badge className="bg-slate-100 text-slate-700 border-slate-300 text-[9px] shrink-0">
                        Homologada
                      </Badge>
                    )}
                    <span className="tabular-nums font-medium shrink-0">
                      {fmtMoneda(ven.valor)}
                    </span>
                    <span className="text-muted-foreground shrink-0 w-10 text-right">
                      {horaColombia(ven.fechaCreacion)}
                    </span>
                  </div>
                ))
              )}
            </Cifra>

            <Cifra
              icono={Wallet}
              label="Efectivo al cierre"
              calculado={t.efectivoCierre}
              vista={v ? Number(v.efectivo) : null}
              tono={t.efectivoCierre < 0 ? "text-red-700" : ""}
              detalle={v ? `Venía de ${fmtMoneda(Number(v.caja_anterior))}` : undefined}
              formula="Caja anterior + ingresos + recaudo − ventas − gastos − retiros."
              abierto={abierta === "caja"}
              onToggle={() => alternar("caja")}
            >
              {!v ? (
                <Vacio texto="Sin resumen para ese día, no hay caja anterior." />
              ) : (
                <div className="text-[11px] space-y-0.5">
                  {(
                    [
                      ["Caja del día anterior", Number(v.caja_anterior), 1],
                      ["Ingresos", t.ingresos, 1],
                      ["Recaudo", t.valorPago, 1],
                      ["Ventas entregadas", t.ventasCaja, -1],
                      ["Gastos", t.gastos, -1],
                      ["Retiros", t.retiros, -1],
                    ] as const
                  ).map(([etq, val, signo]) => (
                    <div key={etq} className="flex items-center gap-2">
                      <span className="flex-1 text-muted-foreground">{etq}</span>
                      <span
                        className={`tabular-nums font-medium ${
                          signo < 0 ? "text-red-600" : ""
                        }`}
                      >
                        {signo < 0 ? "−" : "+"}
                        {fmtMoneda(Math.abs(val))}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 border-t pt-1 mt-1">
                    <span className="flex-1 font-semibold">Efectivo al cierre</span>
                    <span className="tabular-nums font-bold">
                      {fmtConSigno(t.efectivoCierre)}
                    </span>
                  </div>
                </div>
              )}
            </Cifra>
          </div>

          {/* ── Lo que NO entró en ningún total ──────────────────────────── */}
          {datos.eventosFuera.length > 0 && (
            <Card className="border-amber-300 bg-amber-50/40">
              <CardContent className="p-3">
                <div
                  className="flex items-center gap-1.5 cursor-pointer"
                  onClick={() => alternar("fuera")}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      alternar("fuera")
                    }
                  }}
                >
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                  <span className="text-xs font-semibold">
                    Eventos que no entran en ningún número ({datos.eventosFuera.length})
                  </span>
                  {abierta === "fuera" ? (
                    <ChevronDown className="h-3.5 w-3.5 ml-auto" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Quedaron en revisión, fueron rechazados, o son extensiones y
                  ajustes de cronograma que no mueven plata. Están en el libro, pero
                  ninguna cifra del día los cuenta.
                </div>
                {abierta === "fuera" && (
                  <div className="mt-2">
                    {datos.eventosFuera.map((ev) => (
                      <div key={ev.id} className="border-b last:border-b-0">
                        <div className="text-[11px] font-medium truncate">
                          {ev.cliente}
                        </div>
                        <Evento ev={ev} />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {cargando && (
        <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Armando el día…
        </div>
      )}
    </div>
  )
}
