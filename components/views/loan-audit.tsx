"use client"

/**
 * Auditoría 360
 * -------------
 * La película completa de un préstamo, para cuando un vendedor dice
 * "no me cuadra este número".
 *
 * De dónde sale todo:
 *   `payment_plan` es el cronograma pactado e inmutable (fecha_pago = el
 *   VENCIMIENTO) y `gestiones` es el libro de eventos INSERT-only. Saldo,
 *   mora y estado de cada cuota NO se guardan: se DERIVAN de esas dos
 *   fuentes. Esta pantalla no recalcula nada por su cuenta — le pide la
 *   película ya armada a la RPC `auditoria_prestamo(p_loan_id)`
 *   (scripts/048), que usa LAS MISMAS fórmulas de las vistas vivas.
 *
 * Lo que se ve, en orden:
 *   1. Buscador de préstamos de la ruta.
 *   2. Términos pactados (incluye la marca de venta homologada).
 *   3. Los números de hoy CON su fórmula al lado. Este es el corazón: el
 *      número solo no convence a nadie; el número y su origen, sí.
 *   4. Línea de tiempo día a día: qué vencía, qué eventos hubo, y cómo
 *      quedaron el saldo y la mora al cierre de ese día.
 *   5. El cronograma cuota por cuota con su estado derivado.
 *
 * Es una pantalla de SOLO LECTURA. Aquí no se corrige nada: para eso está
 * el Control de Pagos y el editor de secretaría.
 *
 * OJO con la RPC: `auditoria_prestamo` NO tiene la firma atómica de cuatro
 * parámetros, así que no se llama con `callRpcAtomic` sino con el cliente
 * directo.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getSupabaseSafe } from "@/lib/api-helper"
import {
  fmtFecha,
  fmtFechaHora,
  fmtMoneda,
  etiquetaMora,
  colorMora,
  etiquetaFrecuencia,
  todayColombia,
  type Gestion,
  type EstadoCuota,
} from "@/lib/gestion-core"
import {
  AlertCircle,
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ClipboardList,
  FileSearch,
  History,
  Loader2,
  MapPin,
  RefreshCw,
  Search,
  Wallet,
} from "lucide-react"

// ───────────────────────────────────────────────────────────────────────────
// El contrato de `auditoria_prestamo` (scripts/048)
// ───────────────────────────────────────────────────────────────────────────

interface AudTerminos {
  loan_id: string
  cliente: string | null
  valor: number | null
  tasa_interes: number | null
  tipo_amortizacion: string | null
  frecuencia_pago: string | null
  numero_cuotas: number | null
  valor_cuota: number | null
  total_a_pagar: number | null
  saldo_inicial: number | null
  origen: string
  fecha_creacion: string | null
  fecha_primer_pago: string | null
  estado: string | null
}

interface AudCuota {
  cuota_id: string
  numero: number
  vence: string
  valor: number
  es_extra: boolean
  estado: EstadoCuota
  asignado: number
}

/**
 * Un evento del libro, tal como lo devuelve la auditoría: comparte columnas
 * con `Gestion` y agrega lo ya resuelto por la RPC (el nombre del usuario y
 * la hora Colombia ya formateada).
 */
type AudEvento = Pick<
  Gestion,
  "id" | "tipo" | "monto" | "estado" | "origen" | "observacion" | "detalle"
> & {
  usuario: string | null
  motivo_revision: string | null
  referencia: string | null
  hora: string | null
}

interface AudVencimiento {
  numero: number
  valor: number
}

interface AudDia {
  fecha: string
  vencia: AudVencimiento[]
  eventos: AudEvento[]
  pagado_acumulado: number
  saldo_cierre: number
  mora_cierre: number
}

interface AudActual {
  saldo: number
  saldo_hoy: number
  total_pagado: number
  saldo_en_mora: number
  cuotas_mora: number
  cuotas_cubiertas: number
  cuotas_totales: number
}

interface AudFormulas {
  saldo: string
  mora: string
}

interface AuditoriaOk {
  ok: true
  terminos: AudTerminos
  cuotas: AudCuota[]
  dias: AudDia[]
  actual: AudActual
  formulas: AudFormulas
}

interface AuditoriaError {
  ok: false
  error?: string
}

type AuditoriaRpc = AuditoriaOk | AuditoriaError

// Un préstamo en el buscador.
interface LoanBusqueda {
  id: string
  valor: number
  saldo: number
  estado: string
  numero_cuotas: number
  origen: string
  fecha_creacion: string | null
  ruta: number | null
  nombre: string
  apodo: string | null
  documento: string
}

interface LoanAuditProps {
  currentRutaId: number
  loanIdInicial?: string
  onBack?: () => void
}

// ───────────────────────────────────────────────────────────────────────────
// Etiquetas y colores
// ───────────────────────────────────────────────────────────────────────────

const ESTILO_EVENTO: Record<string, { label: string; chip: string }> = {
  pago:        { label: "Pago",        chip: "bg-green-100 text-green-800 border-green-300" },
  abono_venta: { label: "Abono venta", chip: "bg-teal-100 text-teal-800 border-teal-300" },
  no_pago:     { label: "No pago",     chip: "bg-amber-100 text-amber-900 border-amber-300" },
  cancelacion: { label: "Cancelación", chip: "bg-blue-100 text-blue-800 border-blue-300" },
  reversa:     { label: "Reversa",     chip: "bg-red-100 text-red-800 border-red-300" },
  ajuste:      { label: "Ajuste",      chip: "bg-slate-100 text-slate-700 border-slate-300" },
  extension:   { label: "Extensión",   chip: "bg-violet-100 text-violet-800 border-violet-300" },
}

const ESTILO_CUOTA: Record<string, { label: string; badge: string }> = {
  pagado:    { label: "Pagada",    badge: "bg-green-100 text-green-800 border-green-200" },
  pendiente: { label: "Pendiente", badge: "bg-slate-100 text-slate-700 border-slate-200" },
  parcial:   { label: "Parcial",   badge: "bg-amber-100 text-amber-800 border-amber-200" },
  no_pago:   { label: "No pago",   badge: "bg-red-100 text-red-800 border-red-200" },
  cancelada: { label: "Cancelada", badge: "bg-blue-100 text-blue-800 border-blue-200" },
}

const ETIQUETA_ORIGEN: Record<string, string> = {
  campo:        "Campo",
  venta:        "Venta",
  homologacion: "Homologación",
  revision:     "Revisión",
  ajuste:       "Ajuste",
  migracion:    "Migración",
}

const ETIQUETA_AMORTIZACION: Record<string, string> = {
  aleman:    "Capital (alemán)",
  americano: "Interés (americano)",
  empleado:  "Empleado",
}

const TONO_MORA: Record<string, string> = {
  verde:    "text-green-700",
  amarillo: "text-amber-600",
  rojo:     "text-red-600",
}

/** Un número que puede venir como string desde jsonb. */
const n = (v: unknown): number => {
  const x = Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}

/** Fecha corta "12 ago" para la línea de tiempo, sin corrimiento de UTC. */
const fmtDiaCorto = (iso: string): string => {
  const [y, m, d] = iso.split("T")[0].split("-").map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "short",
  })
}

/** Los primeros 8 caracteres de un uuid, para nombrar un evento sin gritar. */
const corto = (id: string | null | undefined): string =>
  id ? id.slice(0, 8) : "—"

/** ¿Este día tiene algo que contar? */
const diaConMovimiento = (d: AudDia): boolean =>
  d.eventos.length > 0 || d.vencia.length > 0

// ───────────────────────────────────────────────────────────────────────────
// Piezas de presentación
// ───────────────────────────────────────────────────────────────────────────

/** Una cifra grande con su fórmula debajo. */
function TarjetaCifra({
  icono: Icono,
  label,
  valor,
  detalle,
  tono,
}: {
  icono: typeof Wallet
  label: string
  valor: string
  detalle?: string
  tono?: string
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icono className="h-3.5 w-3.5" />
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-0.5 text-lg md:text-2xl font-bold tabular-nums ${tono ?? ""}`}>
        {valor}
      </div>
      {detalle && (
        <div className="text-[11px] text-muted-foreground mt-0.5">{detalle}</div>
      )}
    </div>
  )
}

/**
 * Un evento del libro. Muestra tipo, monto, hora y quién lo hizo; y todo lo
 * que hace falta para entenderlo: si está en revisión, a qué evento anula,
 * y el botón para abrir su detalle.
 */
function ChipEvento({
  ev,
  referido,
  onVerDetalle,
}: {
  ev: AudEvento
  referido?: { ev: AudEvento; fecha: string }
  onVerDetalle: (ev: AudEvento) => void
}) {
  const estilo = ESTILO_EVENTO[ev.tipo] ?? {
    label: ev.tipo,
    chip: "bg-slate-100 text-slate-700 border-slate-300",
  }
  const anulado = ev.estado === "rechazada"
  const enRevision = ev.estado === "en_revision"
  const tieneDetalle = !!ev.detalle && Object.keys(ev.detalle).length > 0

  return (
    <div
      className={`rounded-lg border px-2 py-1.5 text-[11px] leading-tight ${
        enRevision
          ? "border-dashed border-amber-400 bg-amber-50/60"
          : "border-transparent bg-muted/30"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-block rounded-full border px-1.5 py-0.5 font-semibold ${estilo.chip} ${
            ev.tipo === "reversa" || anulado ? "line-through" : ""
          }`}
        >
          {estilo.label}
        </span>
        {ev.tipo !== "no_pago" && n(ev.monto) !== 0 && (
          <span
            className={`font-bold tabular-nums ${
              ev.tipo === "reversa" ? "text-red-600" : ""
            }`}
          >
            {ev.tipo === "reversa" ? "−" : ""}
            {fmtMoneda(n(ev.monto))}
          </span>
        )}
        {ev.hora && <span className="text-muted-foreground">{ev.hora}</span>}
        {ev.usuario && (
          <span className="text-muted-foreground truncate max-w-[10rem]">
            · {ev.usuario}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          · {ETIQUETA_ORIGEN[ev.origen] ?? ev.origen}
        </span>
      </div>

      {enRevision && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Badge className="bg-amber-100 text-amber-900 border-amber-300 text-[9px] px-1.5 py-0">
            en revisión
          </Badge>
          {ev.motivo_revision && (
            <span className="text-amber-800">{ev.motivo_revision}</span>
          )}
        </div>
      )}

      {ev.estado === "rechazada" && (
        <div className="mt-1">
          <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
            rechazada · no cuenta
          </Badge>
        </div>
      )}

      {ev.tipo === "reversa" && ev.referencia && (
        <div className="mt-1 text-red-700">
          Anula{" "}
          {referido
            ? `${(ESTILO_EVENTO[referido.ev.tipo]?.label ?? referido.ev.tipo).toLowerCase()} de ${fmtMoneda(
                n(referido.ev.monto),
              )} del ${fmtDiaCorto(referido.fecha)}`
            : `la gestión ${corto(ev.referencia)}`}
        </div>
      )}

      {ev.observacion && (
        <div className="mt-1 text-muted-foreground break-words">{ev.observacion}</div>
      )}

      {tieneDetalle && (
        <button
          type="button"
          onClick={() => onVerDetalle(ev)}
          className="mt-1 text-[10px] font-semibold text-brand underline underline-offset-2 hover:opacity-80"
        >
          ver detalle
        </button>
      )}
    </div>
  )
}

/** Las cuotas que vencían ese día. */
function CeldaVencia({ vencia }: { vencia: AudVencimiento[] }) {
  if (vencia.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {vencia.map((v) => (
        <span
          key={`${v.numero}-${v.valor}`}
          className="inline-block rounded border bg-background px-1.5 py-0.5 text-[10px] whitespace-nowrap"
        >
          #{v.numero} · {fmtMoneda(n(v.valor))}
        </span>
      ))}
    </div>
  )
}

/** Renderiza un valor suelto del jsonb de `detalle`. */
function valorLegible(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "boolean") return v ? "sí" : "no"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

const nombreCampo = (k: string): string => k.replace(/_/g, " ")

/**
 * El detalle de un evento. Los ajustes de secretaría guardan `antes` y
 * `despues` (scripts/046): cuando existen se muestran lado a lado y se
 * resaltan solo los campos que cambiaron, que es lo único que importa.
 */
function DialogoDetalle({
  ev,
  onClose,
}: {
  ev: AudEvento | null
  onClose: () => void
}) {
  const detalle = (ev?.detalle ?? {}) as Record<string, unknown>
  const antes = detalle.antes as Record<string, unknown> | null | undefined
  const despues = detalle.despues as Record<string, unknown> | null | undefined
  const hayComparacion =
    (antes && typeof antes === "object") || (despues && typeof despues === "object")

  const claves = Array.from(
    new Set([...Object.keys(antes ?? {}), ...Object.keys(despues ?? {})]),
  )
  const otras = Object.entries(detalle).filter(
    ([k]) => k !== "antes" && k !== "despues",
  )

  return (
    <Dialog open={!!ev} onOpenChange={(abierto) => { if (!abierto) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">
            Detalle de {ev ? (ESTILO_EVENTO[ev.tipo]?.label ?? ev.tipo).toLowerCase() : "la gestión"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {ev ? `Gestión ${corto(ev.id)} · ${ev.hora ?? "sin hora"}` : ""}
          </DialogDescription>
        </DialogHeader>

        {!ev ? null : (
          <div className="space-y-3 text-xs">
            {hayComparacion && (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-[11px] text-muted-foreground">
                      <th className="py-1 pr-2 font-semibold">Campo</th>
                      <th className="py-1 pr-2 font-semibold">Antes</th>
                      <th className="py-1 font-semibold">Después</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claves.map((k) => {
                      const a = valorLegible(antes?.[k])
                      const d = valorLegible(despues?.[k])
                      const cambio = a !== d
                      return (
                        <tr
                          key={k}
                          className={`border-t ${cambio ? "bg-amber-50/60" : ""}`}
                        >
                          <td className="py-1 pr-2 align-top text-muted-foreground capitalize">
                            {nombreCampo(k)}
                          </td>
                          <td
                            className={`py-1 pr-2 align-top break-all ${
                              cambio ? "line-through text-red-700" : ""
                            }`}
                          >
                            {a}
                          </td>
                          <td
                            className={`py-1 align-top break-all ${
                              cambio ? "font-semibold text-green-800" : ""
                            }`}
                          >
                            {d}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {otras.length > 0 && (
              <>
                {hayComparacion && <Separator />}
                <dl className="space-y-1">
                  {otras.map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="text-muted-foreground capitalize shrink-0">
                        {nombreCampo(k)}:
                      </dt>
                      <dd className="break-all">{valorLegible(v)}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}

            {!hayComparacion && otras.length === 0 && (
              <p className="text-muted-foreground">Este evento no guardó detalle.</p>
            )}

            {ev.observacion && (
              <>
                <Separator />
                <p className="text-muted-foreground">{ev.observacion}</p>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// La pantalla
// ───────────────────────────────────────────────────────────────────────────

export function LoanAudit({ currentRutaId, loanIdInicial, onBack }: LoanAuditProps) {
  const hoy = todayColombia()

  // ── Buscador ─────────────────────────────────────────────────────────
  const [prestamos, setPrestamos] = useState<LoanBusqueda[]>([])
  const [cargandoLista, setCargandoLista] = useState(true)
  const [errorLista, setErrorLista] = useState<string | null>(null)
  const [termino, setTermino] = useState("")
  // Filtro de ruta. Arranca en la ruta de la sesión, pero secretaría atiende
  // varias: cuando un cobrador reclama por un número, no tiene por qué ser de
  // la ruta que uno tenga abierta. "todas" busca en la cartera completa.
  const [rutas, setRutas] = useState<{ id: number; nombre: string }[]>([])
  const [rutaFiltro, setRutaFiltro] = useState<number | "todas">(currentRutaId)

  // ── Préstamo auditado ────────────────────────────────────────────────
  const [loanId, setLoanId] = useState<string | null>(loanIdInicial ?? null)
  const [aud, setAud] = useState<AuditoriaOk | null>(null)
  const [cargandoAud, setCargandoAud] = useState(false)
  const [errorAud, setErrorAud] = useState<string | null>(null)

  const [soloMovimiento, setSoloMovimiento] = useState(true)
  const [detalleAbierto, setDetalleAbierto] = useState<AudEvento | null>(null)

  // ── Catálogo de rutas ────────────────────────────────────────────────
  useEffect(() => {
    let cancelado = false
    getSupabaseSafe()
      .then((supabase) => supabase.from("rutas").select("id, nombre").order("id"))
      .then(({ data }) => {
        if (!cancelado) setRutas((data ?? []) as { id: number; nombre: string }[])
      })
      .catch((err) => console.error("[v0] LoanAudit rutas error:", err))
    return () => {
      cancelado = true
    }
  }, [])

  // ── Préstamos de la ruta elegida ─────────────────────────────────────
  useEffect(() => {
    let cancelado = false
    const cargar = async () => {
      setCargandoLista(true)
      setErrorLista(null)
      try {
        const supabase = await getSupabaseSafe()
        let q = supabase
          .from("loans")
          .select(
            "id, valor, saldo, estado, numero_cuotas, origen, fecha_creacion, ruta, " +
              "clients:clients(nombre_completo, apodo, documento)",
          )
          .order("fecha_creacion", { ascending: false })
          .limit(500)
        // Sin RLS, el filtro por ruta es responsabilidad de la app.
        if (rutaFiltro !== "todas") q = q.eq("ruta", rutaFiltro)

        const { data, error } = await q
        if (cancelado) return
        if (error) throw new Error(error.message)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filas: LoanBusqueda[] = (data ?? []).map((l: any) => ({
          id: l.id,
          valor: n(l.valor),
          saldo: n(l.saldo),
          estado: l.estado ?? "",
          numero_cuotas: n(l.numero_cuotas),
          origen: l.origen ?? "normal",
          fecha_creacion: l.fecha_creacion ?? null,
          ruta: l.ruta ?? null,
          nombre: l.clients?.nombre_completo ?? "Sin nombre",
          apodo: l.clients?.apodo ?? null,
          documento: l.clients?.documento ?? "",
        }))
        setPrestamos(filas)
      } catch (err) {
        console.error("[v0] LoanAudit cargarPrestamos error:", err)
        if (!cancelado) {
          setErrorLista(
            err instanceof Error ? err.message : "No se pudieron cargar los préstamos.",
          )
        }
      } finally {
        if (!cancelado) setCargandoLista(false)
      }
    }
    cargar()
    return () => {
      cancelado = true
    }
  }, [rutaFiltro])

  // Si el padre cambia el préstamo inicial, se sigue.
  useEffect(() => {
    if (loanIdInicial) setLoanId(loanIdInicial)
  }, [loanIdInicial])

  // ── La auditoría ─────────────────────────────────────────────────────
  const cargarAuditoria = useCallback(async (id: string) => {
    setCargandoAud(true)
    setErrorAud(null)
    try {
      // `auditoria_prestamo` es de LECTURA y solo recibe p_loan_id: no pasa
      // por callRpcAtomic (esa firma es la de las escrituras atómicas).
      const supabase = await getSupabaseSafe()
      const { data, error } = await supabase.rpc("auditoria_prestamo", {
        p_loan_id: id,
      })
      if (error) throw new Error(error.message)

      const res = data as AuditoriaRpc | null
      if (!res) throw new Error("La auditoría no devolvió datos.")
      if (!res.ok) throw new Error(res.error ?? "No se pudo auditar el préstamo.")
      setAud(res)
    } catch (err) {
      console.error("[v0] LoanAudit cargarAuditoria error:", err)
      setAud(null)
      setErrorAud(
        err instanceof Error ? err.message : "No se pudo cargar la auditoría.",
      )
    } finally {
      setCargandoAud(false)
    }
  }, [])

  useEffect(() => {
    if (!loanId) {
      setAud(null)
      setErrorAud(null)
      return
    }
    cargarAuditoria(loanId)
  }, [loanId, cargarAuditoria])

  const nombreRuta = useCallback(
    (id: number) => rutas.find((r) => r.id === id)?.nombre ?? `Ruta ${id}`,
    [rutas],
  )

  // ── Filtrado del buscador ────────────────────────────────────────────
  const resultados = useMemo(() => {
    const t = termino.trim().toLowerCase()
    const base = t
      ? prestamos.filter(
          (p) =>
            p.apodo?.toLowerCase().includes(t) ||
            p.nombre.toLowerCase().includes(t) ||
            p.documento.toLowerCase().includes(t) ||
            p.id.toLowerCase().includes(t),
        )
      : prestamos
    return base.slice(0, 60)
  }, [prestamos, termino])

  // Los eventos indexados por id: una reversa apunta a otro evento y hay que
  // poder decir a QUÉ anula, no solo su uuid.
  const eventosPorId = useMemo(() => {
    const mapa = new Map<string, { ev: AudEvento; fecha: string }>()
    if (!aud) return mapa
    for (const d of aud.dias) {
      for (const e of d.eventos) mapa.set(e.id, { ev: e, fecha: d.fecha })
    }
    return mapa
  }, [aud])

  const diasVisibles = useMemo(() => {
    if (!aud) return []
    return soloMovimiento ? aud.dias.filter(diaConMovimiento) : aud.dias
  }, [aud, soloMovimiento])

  const diasOcultos = aud ? aud.dias.length - aud.dias.filter(diaConMovimiento).length : 0

  const abrirPrestamo = (id: string) => {
    setLoanId(id)
    setSoloMovimiento(true)
  }

  const volverAlBuscador = () => {
    setLoanId(null)
    setAud(null)
    setErrorAud(null)
  }

  // ─────────────────────────────────────────────────────────────────────
  // Encabezado
  // ─────────────────────────────────────────────────────────────────────
  const encabezado = (
    <div className="flex items-center gap-2">
      {(onBack || loanId) && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1"
          onClick={loanId ? volverAlBuscador : onBack}
        >
          <ChevronLeft className="h-4 w-4" />
          {loanId ? "Buscar otro" : "Volver"}
        </Button>
      )}
      <div className="min-w-0">
        <h1 className="text-lg md:text-2xl font-bold flex items-center gap-2">
          <FileSearch className="h-5 w-5 shrink-0" />
          Auditoría 360
        </h1>
        <p className="text-xs text-muted-foreground">
          De dónde sale cada número de un préstamo, día por día.
        </p>
      </div>
    </div>
  )

  // ─────────────────────────────────────────────────────────────────────
  // BUSCADOR
  // ─────────────────────────────────────────────────────────────────────
  if (!loanId) {
    return (
      <div className="space-y-4">
        {encabezado}

        <Card>
          <CardContent className="p-3 md:p-4 space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por apodo, nombre o documento..."
                  value={termino}
                  onChange={(e) => setTermino(e.target.value)}
                  className="pl-8 h-9"
                />
              </div>
              <Select
                value={String(rutaFiltro)}
                onValueChange={(v) => setRutaFiltro(v === "todas" ? "todas" : Number(v))}
              >
                <SelectTrigger className="h-9 w-full sm:w-52">
                  <MapPin className="h-3.5 w-3.5 mr-1.5 shrink-0 text-muted-foreground" />
                  <SelectValue placeholder="Ruta" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todas">Todas las rutas</SelectItem>
                  {rutas.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {cargandoLista
                ? "Cargando préstamos..."
                : `${prestamos.length} préstamo${prestamos.length === 1 ? "" : "s"} en ${
                    rutaFiltro === "todas" ? "todas las rutas" : nombreRuta(rutaFiltro)
                  }${prestamos.length >= 500 ? " (se muestran los 500 más recientes)" : ""}`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="px-0 md:px-3 py-0 md:py-2">
            {cargandoLista ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : errorLista ? (
              <div className="text-center py-10 px-4 text-muted-foreground flex flex-col items-center gap-2">
                <AlertTriangle className="h-8 w-8 text-red-500 opacity-70" />
                <span className="text-sm">{errorLista}</span>
              </div>
            ) : resultados.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground flex flex-col items-center gap-2">
                <AlertCircle className="h-8 w-8 opacity-40" />
                <span className="text-sm">
                  {termino
                    ? "Ningún préstamo coincide con la búsqueda."
                    : rutaFiltro === "todas"
                      ? "No hay préstamos registrados."
                      : `${nombreRuta(rutaFiltro)} no tiene préstamos registrados.`}
                </span>
                {termino && rutaFiltro !== "todas" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 h-7 text-xs"
                    onClick={() => setRutaFiltro("todas")}
                  >
                    Buscar en todas las rutas
                  </Button>
                )}
              </div>
            ) : (
              <ul className="divide-y">
                {resultados.map((p) => (
                  <li
                    key={p.id}
                    className="px-3 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                    onClick={() => abrirPrestamo(p.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-sm truncate">
                            {p.apodo || p.nombre}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {p.documento}
                          </span>
                          {p.estado !== "activo" && (
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                              {p.estado}
                            </Badge>
                          )}
                          {/* Al buscar en todas las rutas hay que poder ver de
                              cuál es cada préstamo: dos clientes distintos
                              pueden llamarse igual en rutas distintas. */}
                          {rutaFiltro === "todas" && p.ruta != null && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                              {nombreRuta(p.ruta)}
                            </Badge>
                          )}
                          {p.origen === "homologado" && (
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1.5 py-0 border-violet-300 text-violet-700"
                            >
                              homologada
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span className="tabular-nums">
                            Prestado {fmtMoneda(p.valor)} · {p.numero_cuotas} cuotas
                          </span>
                          <span className="tabular-nums whitespace-nowrap">
                            Saldo{" "}
                            <strong className="text-foreground">{fmtMoneda(p.saldo)}</strong>
                          </span>
                        </div>
                      </div>
                      <ChevronLeft className="h-4 w-4 text-muted-foreground rotate-180 shrink-0 mt-1" />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────
  // CARGA / ERROR DE LA AUDITORÍA
  // ─────────────────────────────────────────────────────────────────────
  if (cargandoAud) {
    return (
      <div className="space-y-4">
        {encabezado}
        <Card>
          <CardContent className="p-4 space-y-3">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-72" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Armando la película del préstamo...
        </p>
      </div>
    )
  }

  if (errorAud || !aud) {
    return (
      <div className="space-y-4">
        {encabezado}
        <Card>
          <CardContent className="p-6 text-center flex flex-col items-center gap-3">
            <AlertTriangle className="h-10 w-10 text-red-500 opacity-70" />
            <p className="text-sm font-semibold">No se pudo cargar la auditoría</p>
            <p className="text-xs text-muted-foreground max-w-md">
              {errorAud ?? "La auditoría no devolvió datos."}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={volverAlBuscador}>
                Volver al buscador
              </Button>
              <Button size="sm" className="gap-1" onClick={() => cargarAuditoria(loanId)}>
                <RefreshCw className="h-3.5 w-3.5" />
                Reintentar
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────
  // AUDITORÍA
  // ─────────────────────────────────────────────────────────────────────
  const t = aud.terminos
  const a = aud.actual
  const homologada = t.origen === "homologado"
  const tonoMora = TONO_MORA[colorMora(n(a.cuotas_mora))] ?? ""

  return (
    <div className="space-y-4">
      {encabezado}

      {/* ── 1. Términos pactados ───────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base md:text-xl font-bold truncate">
                  {t.cliente ?? "Sin nombre"}
                </h2>
                <Badge variant={t.estado === "activo" ? "default" : "secondary"}>
                  {t.estado ?? "—"}
                </Badge>
                {t.tipo_amortizacion && (
                  <Badge variant="outline">
                    {ETIQUETA_AMORTIZACION[t.tipo_amortizacion] ?? t.tipo_amortizacion}
                  </Badge>
                )}
                {homologada && (
                  <Badge
                    className="bg-violet-100 text-violet-800 border-violet-300"
                    title="Migrada de otro sistema con su historia"
                  >
                    Venta homologada
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Préstamo {corto(t.loan_id)} · creado {fmtFechaHora(t.fecha_creacion)}
              </p>
              {homologada && (
                <p className="text-[11px] text-violet-700 mt-0.5">
                  Migrada de otro sistema con su historia: los eventos de
                  homologación no son plata que entró a la caja de esta ruta.
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1 shrink-0"
              onClick={() => cargarAuditoria(loanId)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Actualizar
            </Button>
          </div>

          <Separator />

          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3 text-sm">
            {[
              { k: "Valor prestado", v: fmtMoneda(n(t.valor)) },
              { k: "Tasa de interés", v: `${n(t.tasa_interes)}%` },
              { k: "Frecuencia", v: etiquetaFrecuencia(t.frecuencia_pago) },
              { k: "N.° de cuotas", v: String(n(t.numero_cuotas)) },
              { k: "Valor de cuota", v: fmtMoneda(n(t.valor_cuota)) },
              { k: "Total a pagar", v: fmtMoneda(n(t.total_a_pagar)) },
              { k: "Primer pago", v: fmtFecha(t.fecha_primer_pago) },
              { k: "Saldo inicial", v: fmtMoneda(n(t.saldo_inicial)) },
            ].map((d) => (
              <div key={d.k}>
                <dt className="text-[11px] text-muted-foreground">{d.k}</dt>
                <dd className="font-semibold tabular-nums">{d.v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {/* ── 2. Los números de hoy, con su fórmula ───────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base md:text-lg flex items-center gap-2">
            <Wallet className="h-4 w-4" />
            Los números de hoy
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <TarjetaCifra
              icono={Wallet}
              label="Saldo"
              valor={fmtMoneda(n(a.saldo))}
              detalle={`Saldo de hoy ${fmtMoneda(n(a.saldo_hoy))}`}
            />
            <TarjetaCifra
              icono={ClipboardList}
              label="Total pagado"
              valor={fmtMoneda(n(a.total_pagado))}
              detalle={`de ${fmtMoneda(n(t.total_a_pagar))}`}
              tono="text-green-700"
            />
            <TarjetaCifra
              icono={AlertTriangle}
              label="Mora"
              valor={etiquetaMora(n(a.cuotas_mora))}
              detalle={`${fmtMoneda(n(a.saldo_en_mora))} vencido sin cubrir`}
              tono={tonoMora}
            />
            <TarjetaCifra
              icono={CalendarDays}
              label="Cuotas cubiertas"
              valor={`${n(a.cuotas_cubiertas)} / ${n(a.cuotas_totales)}`}
              detalle="sin contar las extra"
            />
          </div>

          {/* El corazón del módulo: el número JUNTO a su fórmula. */}
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Cómo se calcula
            </p>
            <p className="text-xs md:text-sm break-words">
              <span className="font-semibold">Saldo:</span> {aud.formulas.saldo}
            </p>
            <p className="text-xs md:text-sm break-words">
              <span className="font-semibold">Mora:</span> {aud.formulas.mora}
            </p>
            <p className="text-[11px] text-muted-foreground pt-1">
              Nada de esto está guardado: sale del cronograma pactado y del libro
              de eventos, con las mismas fórmulas que usan las demás pantallas.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── 3. Línea de tiempo día a día ────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 space-y-2">
          <CardTitle className="text-base md:text-lg flex items-center gap-2">
            <History className="h-4 w-4" />
            Día a día
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSoloMovimiento((v) => !v)}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                soloMovimiento ? "border-brand bg-brand/10 font-semibold" : "hover:bg-muted/50"
              }`}
            >
              Mostrar solo días con movimiento
            </button>
            <span className="text-[11px] text-muted-foreground">
              {soloMovimiento
                ? `${diasVisibles.length} días con algo · ${diasOcultos} días quietos ocultos`
                : `${diasVisibles.length} días desde el inicio`}
            </span>
          </div>
        </CardHeader>
        <CardContent className="px-0 md:px-6">
          {diasVisibles.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground flex flex-col items-center gap-2">
              <AlertCircle className="h-8 w-8 opacity-40" />
              <span className="text-sm">Este préstamo todavía no tiene historia.</span>
            </div>
          ) : (
            <>
              {/* Escritorio: tabla que scrollea dentro de su contenedor */}
              <div className="hidden md:block overflow-x-auto max-h-[70vh] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left sticky top-0 z-10">
                    <tr>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Fecha</th>
                      <th className="px-3 py-2 font-semibold">Vencía</th>
                      <th className="px-3 py-2 font-semibold min-w-[18rem]">Eventos</th>
                      <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">
                        Pagado acum.
                      </th>
                      <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">
                        Saldo al cierre
                      </th>
                      <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">
                        Mora al cierre
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {diasVisibles.map((d) => {
                      const quieto = !diaConMovimiento(d)
                      const esHoy = d.fecha === hoy
                      return (
                        <tr
                          key={d.fecha}
                          className={`border-t align-top ${quieto ? "opacity-50" : ""} ${
                            esHoy ? "ring-1 ring-inset ring-brand/40 bg-brand/5" : ""
                          } hover:bg-muted/40`}
                        >
                          <td className={`px-3 py-2 whitespace-nowrap ${quieto ? "py-1" : ""}`}>
                            <span className="font-semibold">{fmtDiaCorto(d.fecha)}</span>
                            {esHoy && (
                              <span className="ml-1 text-[9px] font-bold text-brand uppercase">
                                hoy
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <CeldaVencia vencia={d.vencia} />
                          </td>
                          <td className="px-3 py-2">
                            {d.eventos.length === 0 ? (
                              <span className="text-muted-foreground">
                                {d.vencia.length > 0 ? "Sin gestión" : "—"}
                              </span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                {d.eventos.map((ev) => (
                                  <ChipEvento
                                    key={ev.id}
                                    ev={ev}
                                    referido={
                                      ev.referencia
                                        ? eventosPorId.get(ev.referencia)
                                        : undefined
                                    }
                                    onVerDetalle={setDetalleAbierto}
                                  />
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                            {fmtMoneda(n(d.pagado_acumulado))}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-semibold">
                            {fmtMoneda(n(d.saldo_cierre))}
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${
                              n(d.mora_cierre) > 0 ? "text-red-600 font-semibold" : "text-muted-foreground"
                            }`}
                          >
                            {fmtMoneda(n(d.mora_cierre))}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Móvil: una tarjeta por día */}
              <ul className="md:hidden divide-y">
                {diasVisibles.map((d) => {
                  const quieto = !diaConMovimiento(d)
                  const esHoy = d.fecha === hoy
                  return (
                    <li
                      key={d.fecha}
                      className={`px-3 py-2.5 ${quieto ? "opacity-50 py-1.5" : ""} ${
                        esHoy ? "bg-brand/5" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">
                          {fmtDiaCorto(d.fecha)}
                          {esHoy && (
                            <span className="ml-1 text-[9px] font-bold text-brand uppercase">
                              hoy
                            </span>
                          )}
                        </span>
                        <span className="text-[11px] tabular-nums">
                          Saldo{" "}
                          <strong>{fmtMoneda(n(d.saldo_cierre))}</strong>
                        </span>
                      </div>

                      {d.vencia.length > 0 && (
                        <div className="mt-1.5">
                          <span className="text-[10px] text-muted-foreground">Vencía: </span>
                          <CeldaVencia vencia={d.vencia} />
                        </div>
                      )}

                      {d.eventos.length > 0 && (
                        <div className="mt-1.5 flex flex-col gap-1">
                          {d.eventos.map((ev) => (
                            <ChipEvento
                              key={ev.id}
                              ev={ev}
                              referido={
                                ev.referencia ? eventosPorId.get(ev.referencia) : undefined
                              }
                              onVerDetalle={setDetalleAbierto}
                            />
                          ))}
                        </div>
                      )}

                      {!quieto && (
                        <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground tabular-nums">
                          <span>Pagado acum. {fmtMoneda(n(d.pagado_acumulado))}</span>
                          <span className={n(d.mora_cierre) > 0 ? "text-red-600 font-semibold" : ""}>
                            Mora {fmtMoneda(n(d.mora_cierre))}
                          </span>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── 4. El cronograma cuota por cuota ────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base md:text-lg flex items-center gap-2">
            <ClipboardList className="h-4 w-4" />
            Cuotas
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            El cronograma pactado no se toca: la plata se asigna en cascada por
            orden de vencimiento, y de ahí sale el estado de cada cuota.
          </p>
        </CardHeader>
        <CardContent className="px-0 md:px-6">
          {aud.cuotas.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground flex flex-col items-center gap-2">
              <AlertCircle className="h-8 w-8 opacity-40" />
              <span className="text-sm">Este préstamo no tiene cuotas registradas.</span>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="w-full text-xs md:text-sm">
                <thead className="bg-muted/50 text-left sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2 font-semibold">#</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Vence</th>
                    <th className="px-3 py-2 font-semibold text-right">Valor</th>
                    <th className="px-3 py-2 font-semibold text-right">Asignado</th>
                    <th className="px-3 py-2 font-semibold">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {aud.cuotas.map((c) => {
                    const meta = ESTILO_CUOTA[c.estado] ?? {
                      label: c.estado,
                      badge: "bg-slate-100 text-slate-700 border-slate-200",
                    }
                    const vencida = c.estado === "pendiente" && c.vence < hoy
                    return (
                      <tr
                        key={c.cuota_id}
                        className={`border-t ${vencida ? "bg-red-50/60" : ""} hover:bg-muted/40`}
                      >
                        <td className="px-3 py-2 font-semibold whitespace-nowrap">
                          {c.numero}
                          {c.es_extra && (
                            <span className="ml-1 text-[9px] font-normal text-muted-foreground">
                              extra
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {fmtFecha(c.vence)}
                          {vencida && (
                            <span className="ml-1 text-[9px] font-bold text-red-600 uppercase">
                              vencida
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtMoneda(n(c.valor))}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtMoneda(n(c.asignado))}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.badge}`}
                          >
                            {meta.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <DialogoDetalle ev={detalleAbierto} onClose={() => setDetalleAbierto(null)} />
    </div>
  )
}

export default LoanAudit
