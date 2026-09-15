"use client"

/**
 * Reporte del Administrador.
 *
 * UNA LÍNEA POR RUTA Y POR DÍA, con lo que el dueño mira para saber cómo va
 * cada unidad: cuánto debía cobrar, cuánto cobró, cuánto le faltó, qué se
 * canceló y cuánto gastó.
 *
 * DE DÓNDE SALE CADA NÚMERO — ninguno se inventa acá:
 *
 *   Pretendido           `resumen_diario_v2.meta_pagos` — las cuotas que
 *                        vencen ese día, con la regla de los scripts 104/112
 *                        (un cancelado deja de contar, un atrasado aporta una
 *                        cuota).
 *   Pagos                `cantidad_pagos` — CLIENTES con neto positivo, no
 *                        eventos. Es la regla "un cliente, un día, un
 *                        resultado" del script 070.
 *   Cobrado              `valor_pago` — el neto del día.
 *   Recaudo no alcanzado Pretendido − Cobrado. Negativo cuando se cobró de
 *                        más, y se muestra tal cual: taparlo escondería que
 *                        entró plata de otros días.
 *   Canceladas / $       `cantidad_canceladas` / `valor_canceladas` — los
 *                        créditos que quedaron en cero ese día.
 *   Recaudo Real         Cobrado − $ Canceladas. Lo que entró por cobro
 *                        corriente, sin el golpe de una cancelación.
 *   No Pagos             `cantidad_no_pagos`.
 *   % Recaudo            Cobrado / Pretendido. Sin meta no hay porcentaje: se
 *                        muestra "—" en vez de dividir por cero.
 *   Suma de Gastos       `valor_gastos`.
 *   # Clientes           `vista_monitoreo_admin.cartera_activa` — la cartera
 *                        de ESE día. Si esa ruta no abrió jornada ese día no
 *                        hay fila, y entonces se cae a la cartera de hoy.
 *
 * ES DE SOLO LECTURA. No escribe una sola fila.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  BarChart3,
  Download,
  RefreshCw,
  Search,
} from "lucide-react"
import { getSupabaseSafe } from "@/lib/api-helper"
import { todayColombia } from "@/lib/colombia-date"
import { useToast } from "@/hooks/use-toast"

const TODAS = "__todas"

/** Una fila del reporte: una ruta en un día. */
interface Fila {
  fecha: string
  rutaId: number
  rutaNombre: string
  ciudad: string
  pais: string
  clientes: number | null
  pretendido: number
  pagos: number
  cobrado: number
  canceladas: number
  valorCanceladas: number
  noPagos: number
  gastos: number
  /** Nombres de quienes tienen asignada la ruta. Vacío = sin asignar. */
  trabajadores: string[]
  estadoJornada: string | null
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]

function fmt(n: number): string {
  return Math.round(n).toLocaleString("es-CO")
}

/** Igual que en el resto de la app: el signo va delante del símbolo. */
function fmtConSigno(n: number): string {
  const v = Math.round(n)
  return v < 0 ? `−${fmt(-v)}` : fmt(v)
}

export function ReporteAdministrador() {
  const { toast } = useToast()
  const hoy = todayColombia()

  const [desde, setDesde] = useState(hoy)
  const [hasta, setHasta] = useState(hoy)
  const [pais, setPais] = useState(TODAS)
  const [trabajador, setTrabajador] = useState(TODAS)
  const [unidad, setUnidad] = useState(TODAS)
  const [estado, setEstado] = useState(TODAS)
  const [busqueda, setBusqueda] = useState("")

  const [filas, setFilas] = useState<Fila[]>([])
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      const sb = await getSupabaseSafe()

      // Las cuatro consultas van en paralelo: ninguna depende de otra.
      const [resResumen, resMon, resRutas, resAsign, resUsuarios] = await Promise.all([
        sb
          .from("resumen_diario_v2")
          .select(
            "fecha_pago, ruta, meta_pagos, valor_pago, cantidad_pagos, cantidad_no_pagos, cantidad_canceladas, valor_canceladas, valor_gastos",
          )
          .gte("fecha_pago", desde)
          .lte("fecha_pago", hasta),
        sb
          .from("vista_monitoreo_admin")
          .select("fecha, ruta_id, cartera_activa, estado_ruta")
          .gte("fecha", desde)
          .lte("fecha", hasta),
        sb.from("rutas").select("id, nombre, ciudad, pais"),
        sb.from("usuario_rutas").select("usuario_id, ruta_id"),
        sb.from("usuarios").select("id, nombre, rol, activo"),
      ])

      if (resResumen.error) throw new Error(resResumen.error.message)

      const rutas = new Map(
        ((resRutas.data ?? []) as unknown as {
          id: number
          nombre: string | null
          ciudad: string | null
          pais: string | null
        }[]).map((r) => [r.id, r]),
      )

      const mon = new Map(
        ((resMon.data ?? []) as unknown as {
          fecha: string
          ruta_id: number
          cartera_activa: number | null
          estado_ruta: string | null
        }[]).map((m) => [`${m.ruta_id}|${m.fecha}`, m]),
      )

      // Quién trabaja cada ruta. Una ruta puede tener varios asignados, así
      // que se guarda la lista y no un solo nombre.
      const usuarios = new Map(
        ((resUsuarios.data ?? []) as unknown as {
          id: number
          nombre: string | null
        }[]).map((u) => [u.id, (u.nombre ?? "").trim()]),
      )
      const porRuta = new Map<number, string[]>()
      for (const a of (resAsign.data ?? []) as unknown as {
        usuario_id: number
        ruta_id: number
      }[]) {
        const nom = usuarios.get(a.usuario_id)
        if (!nom) continue
        const lista = porRuta.get(a.ruta_id)
        if (lista) lista.push(nom)
        else porRuta.set(a.ruta_id, [nom])
      }

      const n = (v: unknown) => Number(v) || 0
      const nuevas: Fila[] = ((resResumen.data ?? []) as unknown as Record<string, unknown>[])
        .map((r) => {
          const rutaId = Number(r.ruta)
          const fecha = String(r.fecha_pago)
          const ru = rutas.get(rutaId)
          const m = mon.get(`${rutaId}|${fecha}`)
          return {
            fecha,
            rutaId,
            rutaNombre: ru?.nombre ?? String(rutaId),
            ciudad: ru?.ciudad ?? "",
            pais: ru?.pais ?? "",
            // null = esa ruta no abrió jornada ese día, así que no hay
            // cartera registrada. Se muestra "—" en vez de un 0 que se
            // leería como "no tiene clientes".
            clientes: m?.cartera_activa != null ? Number(m.cartera_activa) : null,
            pretendido: n(r.meta_pagos),
            pagos: n(r.cantidad_pagos),
            cobrado: n(r.valor_pago),
            canceladas: n(r.cantidad_canceladas),
            valorCanceladas: n(r.valor_canceladas),
            noPagos: n(r.cantidad_no_pagos),
            gastos: n(r.valor_gastos),
            trabajadores: porRuta.get(rutaId) ?? [],
            estadoJornada: m?.estado_ruta ?? null,
          }
        })
        // Más reciente arriba, y dentro del día por número de unidad.
        .sort((a, b) => (a.fecha === b.fecha ? a.rutaId - b.rutaId : b.fecha.localeCompare(a.fecha)))

      setFilas(nuevas)
    } catch (err) {
      console.error("[v0] Reporte del Administrador:", err)
      setError(err instanceof Error ? err.message : "No se pudo cargar el reporte")
      setFilas([])
    } finally {
      setCargando(false)
    }
  }, [desde, hasta])

  useEffect(() => {
    void cargar()
  }, [cargar])

  // ── Catálogos para los filtros, sacados de lo que se cargó ──────────────
  const paises = useMemo(
    () => [...new Set(filas.map((f) => f.pais).filter(Boolean))].sort(),
    [filas],
  )
  const trabajadores = useMemo(
    () => [...new Set(filas.flatMap((f) => f.trabajadores))].sort(),
    [filas],
  )
  const unidades = useMemo(
    () => [...new Set(filas.map((f) => f.rutaId))].sort((a, b) => a - b),
    [filas],
  )
  const estados = useMemo(
    () => [...new Set(filas.map((f) => f.estadoJornada).filter(Boolean) as string[])].sort(),
    [filas],
  )

  const visibles = useMemo(() => {
    const t = busqueda.trim().toLowerCase()
    return filas.filter((f) => {
      if (pais !== TODAS && f.pais !== pais) return false
      if (trabajador !== TODAS && !f.trabajadores.includes(trabajador)) return false
      if (unidad !== TODAS && String(f.rutaId) !== unidad) return false
      if (estado !== TODAS && f.estadoJornada !== estado) return false
      if (!t) return true
      return (
        f.rutaNombre.toLowerCase().includes(t) ||
        f.ciudad.toLowerCase().includes(t) ||
        String(f.rutaId).includes(t)
      )
    })
  }, [filas, pais, trabajador, unidad, estado, busqueda])

  // El total es de lo que se ESTÁ VIENDO, no de todo lo cargado: si se filtra
  // por país, el pie tiene que cuadrar con las líneas de arriba.
  const total = useMemo(() => {
    const suma = (fn: (f: Fila) => number) => visibles.reduce((s, f) => s + fn(f), 0)
    const pretendido = suma((f) => f.pretendido)
    const cobrado = suma((f) => f.cobrado)
    const valorCanceladas = suma((f) => f.valorCanceladas)
    return {
      clientes: suma((f) => f.clientes ?? 0),
      pretendido,
      pagos: suma((f) => f.pagos),
      cobrado,
      noAlcanzado: pretendido - cobrado,
      canceladas: suma((f) => f.canceladas),
      valorCanceladas,
      recaudoReal: cobrado - valorCanceladas,
      noPagos: suma((f) => f.noPagos),
      gastos: suma((f) => f.gastos),
      pct: pretendido > 0 ? Math.round((cobrado * 100) / pretendido) : null,
    }
  }, [visibles])

  const exportarCsv = () => {
    if (visibles.length === 0) return
    const cab = [
      "Año", "Mes", "Día", "Ciudad", "Unidad", "Trabajador", "# Clientes",
      "Pretendido", "Pagos", "Cobrado", "Recaudo no alcanzado", "Cancelado",
      "$ Canceladas", "Recaudo Real", "No Pagos", "% Recaudo", "Suma de Gastos",
    ]
    // Se separa con punto y coma: en español el Excel espera `;` y con coma
    // mete todo en una sola columna.
    const filasCsv = visibles.map((f) => {
      const [a, m, d] = f.fecha.split("-")
      const pct = f.pretendido > 0 ? Math.round((f.cobrado * 100) / f.pretendido) : ""
      return [
        a, MESES[Number(m) - 1] ?? m, d, f.ciudad, f.rutaId,
        f.trabajadores.join(" / "), f.clientes ?? "",
        Math.round(f.pretendido), f.pagos, Math.round(f.cobrado),
        Math.round(f.pretendido - f.cobrado), f.canceladas,
        Math.round(f.valorCanceladas), Math.round(f.cobrado - f.valorCanceladas),
        f.noPagos, pct === "" ? "" : `${pct}%`, Math.round(f.gastos),
      ].join(";")
    })
    const csv = [cab.join(";"), ...filasCsv].join("\n")
    // El BOM es lo que hace que Excel lea las tildes bien.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `reporte-administrador_${desde}_${hasta}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: "Reporte descargado", description: `${visibles.length} líneas.` })
  }

  const pctColor = (pct: number | null) => {
    if (pct === null) return "bg-muted text-muted-foreground"
    if (pct >= 80) return "bg-green-600 text-white"
    if (pct >= 50) return "bg-amber-500 text-white"
    return "bg-red-600 text-white"
  }

  return (
    <div className="space-y-3">
      {/* ── Filtros ──────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Desde</Label>
              <Input
                type="date"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Hasta</Label>
              <Input
                type="date"
                value={hasta}
                onChange={(e) => setHasta(e.target.value)}
                className="h-9 text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">País</Label>
              <Select value={pais} onValueChange={setPais}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TODAS} className="text-xs">Todos</SelectItem>
                  {paises.map((p) => (
                    <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Trabajador</Label>
              <Select value={trabajador} onValueChange={setTrabajador}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TODAS} className="text-xs">Todos</SelectItem>
                  {trabajadores.map((t) => (
                    <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Unidad</Label>
              <Select value={unidad} onValueChange={setUnidad}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TODAS} className="text-xs">Todas</SelectItem>
                  {unidades.map((u) => (
                    <SelectItem key={u} value={String(u)} className="text-xs">{u}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Estado</Label>
              <Select value={estado} onValueChange={setEstado}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TODAS} className="text-xs">Todos</SelectItem>
                  {estados.map((e) => (
                    <SelectItem key={e} value={e} className="text-xs capitalize">{e}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[160px]">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar unidad o ciudad…"
                className="h-9 pl-8 text-xs"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void cargar()}
              disabled={cargando}
              className="h-9 gap-1.5 text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${cargando ? "animate-spin" : ""}`} />
              Actualizar
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={exportarCsv}
              disabled={visibles.length === 0}
              className="h-9 gap-1.5 text-xs"
            >
              <Download className="h-3.5 w-3.5" />
              Exportar
            </Button>
            <Badge variant="secondary" className="h-9 rounded-md px-2.5 text-xs">
              {visibles.length} {visibles.length === 1 ? "línea" : "líneas"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {cargando && (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {error && !cargando && (
        <Card>
          <CardContent className="space-y-2 p-4 text-center">
            <AlertTriangle className="mx-auto h-5 w-5 text-amber-600" />
            <p className="text-xs text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void cargar()} className="text-xs">
              Reintentar
            </Button>
          </CardContent>
        </Card>
      )}

      {!cargando && !error && visibles.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center">
            <BarChart3 className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-xs text-muted-foreground">
              No hay movimiento en ese rango con esos filtros.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── La tabla ──────────────────────────────────────────────────────
          Va dentro de su propio `overflow-x-auto`: son 17 columnas de cifras
          y en un teléfono NO caben. Apilarlas en tarjetas haría perder lo
          único que sirve de una tabla así, que es comparar una ruta contra
          otra de un vistazo. El cuerpo de la página no se desplaza; solo
          esta caja. */}
      {!cargando && !error && visibles.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] border-collapse text-[11px]">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-muted-foreground">
                    {[
                      "Año", "Mes", "Día", "Ciudad", "Unidad", "# Clientes",
                      "Pretendido", "Pagos", "Cobrado", "Recaudo no alcanzado",
                      "Cancelado", "$ Canceladas", "Recaudo Real", "No Pagos",
                      "% Recaudo", "Suma de Gastos",
                    ].map((h, i) => (
                      <th
                        key={h}
                        className={`whitespace-nowrap border px-2 py-1.5 font-semibold ${
                          i < 5 ? "text-left" : "text-right"
                        }`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((f) => {
                    const [a, m, d] = f.fecha.split("-")
                    const noAlcanzado = f.pretendido - f.cobrado
                    const real = f.cobrado - f.valorCanceladas
                    const pct = f.pretendido > 0
                      ? Math.round((f.cobrado * 100) / f.pretendido)
                      : null
                    return (
                      <tr key={`${f.rutaId}-${f.fecha}`} className="hover:bg-muted/40">
                        <td className="border px-2 py-1 tabular-nums">{a}</td>
                        <td className="border px-2 py-1">{MESES[Number(m) - 1] ?? m}</td>
                        <td className="border px-2 py-1 tabular-nums">{d}</td>
                        <td className="max-w-[140px] truncate border px-2 py-1" title={f.ciudad}>
                          {f.ciudad || "—"}
                        </td>
                        <td
                          className="border bg-sky-50 px-2 py-1 text-center font-semibold tabular-nums dark:bg-sky-950/40"
                          title={f.trabajadores.length ? f.trabajadores.join(" / ") : "Sin asignar"}
                        >
                          {f.rutaId}
                        </td>
                        <td className="border px-2 py-1 text-right tabular-nums">
                          {f.clientes ?? "—"}
                        </td>
                        <td className="border px-2 py-1 text-right tabular-nums">
                          {fmt(f.pretendido)}
                        </td>
                        <td className="border px-2 py-1 text-right tabular-nums">{f.pagos}</td>
                        <td className="border px-2 py-1 text-right font-semibold tabular-nums">
                          {fmt(f.cobrado)}
                        </td>
                        {/* Negativo = se cobró MÁS de la meta. Se muestra tal
                            cual, en verde: taparlo escondería que entró plata
                            de cuotas de otros días. */}
                        <td
                          className={`border px-2 py-1 text-right tabular-nums ${
                            noAlcanzado < 0 ? "text-green-700 dark:text-green-400" : ""
                          }`}
                        >
                          {fmtConSigno(noAlcanzado)}
                        </td>
                        <td className="border px-2 py-1 text-right tabular-nums">{f.canceladas}</td>
                        <td className="border px-2 py-1 text-right tabular-nums">
                          {fmt(f.valorCanceladas)}
                        </td>
                        <td className="border px-2 py-1 text-right font-semibold tabular-nums">
                          {fmt(real)}
                        </td>
                        <td className="border px-2 py-1 text-right tabular-nums">{f.noPagos}</td>
                        <td className="border px-1 py-1 text-center">
                          <span
                            className={`inline-block w-full rounded px-1 py-0.5 text-[10px] font-bold ${pctColor(pct)}`}
                          >
                            {pct === null ? "—" : `${pct} %`}
                          </span>
                        </td>
                        <td className="border px-2 py-1 text-right tabular-nums">
                          {fmt(f.gastos)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot className="sticky bottom-0 bg-muted font-bold">
                  <tr>
                    <td className="border px-2 py-1.5" colSpan={5}>
                      Total
                    </td>
                    <td className="border px-2 py-1.5 text-right tabular-nums">
                      {total.clientes || "—"}
                    </td>
                    <td className="border px-2 py-1.5 text-right tabular-nums">
                      {fmt(total.pretendido)}
                    </td>
                    <td className="border px-2 py-1.5 text-right tabular-nums">{total.pagos}</td>
                    <td className="border px-2 py-1.5 text-right tabular-nums">
                      {fmt(total.cobrado)}
                    </td>
                    <td
                      className={`border px-2 py-1.5 text-right tabular-nums ${
                        total.noAlcanzado < 0 ? "text-green-700 dark:text-green-400" : ""
                      }`}
                    >
                      {fmtConSigno(total.noAlcanzado)}
                    </td>
                    <td className="border px-2 py-1.5 text-right tabular-nums">
                      {total.canceladas}
                    </td>
                    <td className="border px-2 py-1.5 text-right tabular-nums">
                      {fmt(total.valorCanceladas)}
                    </td>
                    <td className="border px-2 py-1.5 text-right tabular-nums">
                      {fmt(total.recaudoReal)}
                    </td>
                    <td className="border px-2 py-1.5 text-right tabular-nums">{total.noPagos}</td>
                    <td className="border px-1 py-1.5 text-center">
                      <span
                        className={`inline-block w-full rounded px-1 py-0.5 text-[10px] ${pctColor(total.pct)}`}
                      >
                        {total.pct === null ? "—" : `${total.pct} %`}
                      </span>
                    </td>
                    <td className="border px-2 py-1.5 text-right tabular-nums">
                      {fmt(total.gastos)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
