"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { Bandera } from "@/components/bandera"
import { formatearMoneda } from "@/lib/monedas"
import { getResumenDiaRutas } from "@/lib/resumen-dia"
import { todayColombia } from "@/lib/gestion-core"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import {
  Loader2, RefreshCw, AlertCircle,
  Wallet, DollarSign, Target, TrendingUp,
  CheckCircle, XCircle, MinusCircle,
  Receipt, ArrowDownCircle, Clock, Coins, Bike,
} from "lucide-react"

type RutaInfo = { id: number; nombre: string; ciudad: string | null; pais?: string | null; moneda?: string | null }

type ResumenRow = {
  ruta: number
  ruta_nombre: string
  ciudad: string | null
  efectivo: number
  valor_pago: number
  meta_pagos: number
  cantidad_pagos: number
  cantidad_no_pagos: number
  cantidad_canceladas: number
  valor_gastos: number
  valor_retiros: number
  valor_ingresos: number
  hora_ultimo_movimiento: string | null
  pais?: string | null
  moneda?: string | null
}

interface AdminDashboardProps {
  currentUserId?: number | string | null
}

const fmt = (n: number) => `$${Math.round(n).toLocaleString("es-CO")}`

/**
 * El pais de una ruta, escrito para leerse.
 *
 * Dos cosas: en `rutas` conviven "ARGENTINA" y "Argentina", y la 204 tiene
 * `pais` y `ciudad` al reves. Lo segundo se resuelve igual que en el resumen
 * y en `lib/monedas.ts`: si el "pais" resulta ser una ciudad conocida, se usa
 * la otra columna.
 */
function capitalizarPais(pais?: string | null, ciudad?: string | null): string {
  const p = (pais ?? "").trim()
  const c = (ciudad ?? "").trim()
  const pareceCiudad = /buenos aires|la plata|chaco|cuenca|quito|asunci|cali|ibarra|rioamba/i.test(p)
  const bueno = pareceCiudad ? c : p
  return bueno
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => x[0].toUpperCase() + x.slice(1))
    .join(" ")
}
const pctFmt = (val: number, meta: number) =>
  meta > 0 ? `${Math.round((val / meta) * 100)}%` : "—"

const pctColorClass = (val: number, meta: number) => {
  if (meta <= 0) return "text-muted-foreground"
  const p = (val / meta) * 100
  if (p >= 90) return "text-success font-bold"
  if (p >= 60) return "text-warning font-semibold"
  return "text-destructive font-semibold"
}

// La fecha de hoy en Colombia sale de `todayColombia()` (@/lib/gestion-core):
// una sola definicion para toda la app.

export function AdminDashboard({ currentUserId }: AdminDashboardProps) {
  const [fecha, setFecha] = useState(todayColombia)
  const [rutaFilter, setRutaFilter] = useState("all")
  const [ciudadFilter, setCiudadFilter] = useState("all")

  const [rutasDisponibles, setRutasDisponibles] = useState<RutaInfo[]>([])
  const [rows, setRows] = useState<ResumenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Las tasas que regian ESE dia, por moneda. Ver scripts/119. */
  const [tasas, setTasas] = useState<Map<string, number>>(new Map())
  /** Cuantas unidades abrieron y cuantas cerraron ese dia. */
  const [estadosDia, setEstadosDia] = useState<{ abiertas: number; cerradas: number }>({ abiertas: 0, cerradas: 0 })

  // ── Cargar rutas accesibles ────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const supabase = createClient()
      try {
        if (currentUserId) {
          const { data } = await supabase
            .from("usuario_rutas")
            .select("rutas:ruta_id(id, nombre, ciudad, pais, moneda)")
            .eq("usuario_id", currentUserId)
          const rutas = (data ?? [])
            .map((r: any) => r.rutas)
            .filter(Boolean)
            .sort((a: any, b: any) => a.id - b.id) as RutaInfo[]
          setRutasDisponibles(rutas)
        } else {
          const { data } = await supabase
            .from("rutas")
            .select("id, nombre, ciudad, pais, moneda")
            .order("id", { ascending: true })
          setRutasDisponibles((data ?? []) as RutaInfo[])
        }
      } catch (e) {
        console.error("[v0] AdminDashboard rutas error:", e)
      }
    }
    load()
  }, [currentUserId])

  // ── Cargar resumen_diario_v2 ──────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (rutasDisponibles.length === 0) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const rutaIds = rutasDisponibles.map((r) => r.id)
      const rutaInfoMap = new Map(rutasDisponibles.map((r) => [r.id, r]))

      // `getResumenDiaRutas` resuelve el arrastre de la caja. Antes, una ruta
      // sin movimiento ese dia NO traia fila y simplemente desaparecia del
      // tablero: un domingo el admin veia la lista vacia, sin forma de saber
      // si es que nadie trabajo o si algo se habia roto. Ahora todas las rutas
      // aparecen siempre, con su efectivo acumulado y los conteos del dia en
      // cero.
      // ── Las tasas de ESE dia y el estado de cada unidad ────────────────
      // Las dos consultas van en paralelo con el resumen: ninguna depende de
      // la otra y esperar en fila alargaria la carga sin motivo.
      //
      // La TASA es la del dia del tablero, no la de hoy: mirando el 3 de
      // agosto hay que convertir con el dolar del 3 de agosto. Misma regla
      // que `tasa_vigente()` en scripts/119.
      const [porRuta, resTasas, resEstados] = await Promise.all([
        getResumenDiaRutas(supabase, rutaIds, fecha),
        supabase
          .from("tasas_cambio")
          .select("moneda, tasa, vigente_desde, vigente_hasta")
          .lte("vigente_desde", fecha),
        supabase
          .from("rutas_diarias")
          .select("ruta_id, estado")
          .eq("fecha", fecha)
          .in("ruta_id", rutaIds),
      ])

      // Sin el script 119 la tabla no existe: se queda sin tasas y la tarjeta
      // de dolares no se muestra, en vez de tumbar el tablero entero.
      const mapaTasas = new Map<string, number>()
      if (!resTasas.error) {
        // Se queda la MAS RECIENTE que siga cubriendo la fecha. Quedarse con
        // la primera que llegue es quedarse con la que el servidor devuelva
        // primero, que puede ser una vieja: con dos tasas cargadas para la
        // misma moneda se estaria convirtiendo con la cotizacion equivocada.
        const desdePorMoneda = new Map<string, string>()
        for (const t of (resTasas.data ?? []) as unknown as {
          moneda: string; tasa: number; vigente_desde: string; vigente_hasta: string | null
        }[]) {
          // El rango tiene que CONTENER la fecha. Una tasa cerrada antes de
          // ese dia no sirve: estirarla seria inventar una cotizacion.
          if (t.vigente_hasta !== null && t.vigente_hasta < fecha) continue
          const mejor = desdePorMoneda.get(t.moneda)
          if (mejor === undefined || t.vigente_desde > mejor) {
            desdePorMoneda.set(t.moneda, t.vigente_desde)
            mapaTasas.set(t.moneda, Number(t.tasa))
          }
        }
      }
      setTasas(mapaTasas)

      const est = { abiertas: 0, cerradas: 0 }
      for (const e of (resEstados.data ?? []) as unknown as { estado: string }[]) {
        if (e.estado === "abierta") est.abiertas += 1
        else if (e.estado === "cerrada") est.cerradas += 1
      }
      setEstadosDia(est)
      const data = rutaIds.map((id) => {
        const r = porRuta.get(id)
        return { ...(r?.fila ?? {}), ruta: id, sin_movimiento: r?.sinMovimiento ?? true }
      })

      setRows(
        data.map((d: any) => {
          const info = rutaInfoMap.get(d.ruta)
          return {
            ruta: d.ruta,
            ruta_nombre: info?.nombre ?? `Ruta ${d.ruta}`,
            ciudad: info?.ciudad ?? null,
            efectivo: d.efectivo ?? 0,
            valor_pago: d.valor_pago ?? 0,
            meta_pagos: d.meta_pagos ?? 0,
            cantidad_pagos: d.cantidad_pagos ?? 0,
            cantidad_no_pagos: d.cantidad_no_pagos ?? 0,
            cantidad_canceladas: d.cantidad_canceladas ?? 0,
            valor_gastos: d.valor_gastos ?? 0,
            valor_retiros: d.valor_retiros ?? 0,
            valor_ingresos: d.valor_ingresos ?? 0,
            hora_ultimo_movimiento: d.hora_ultimo_movimiento ?? null,
            pais: info?.pais ?? null,
            moneda: info?.moneda ?? null,
          }
        }),
      )
    } catch (e) {
      const msg = (e as any)?.message ?? String(e)
      console.error("[v0] AdminDashboard fetch error:", msg)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [fecha, rutasDisponibles])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Filtrado local ─────────────────────────────────────────────────────────
  const filteredRows = rows.filter((r) => {
    if (rutaFilter !== "all" && r.ruta !== Number(rutaFilter)) return false
    if (ciudadFilter !== "all" && r.ciudad !== ciudadFilter) return false
    return true
  })

  const ciudades = Array.from(
    new Set(rutasDisponibles.map((r) => r.ciudad).filter(Boolean)),
  ) as string[]

  // ── Totales ────────────────────────────────────────────────────────────────
  const totals = filteredRows.reduce(
    (acc, r) => ({
      efectivo:          acc.efectivo          + r.efectivo,
      valor_pago:        acc.valor_pago        + r.valor_pago,
      meta_pagos:        acc.meta_pagos        + r.meta_pagos,
      cantidad_pagos:    acc.cantidad_pagos    + r.cantidad_pagos,
      cantidad_no_pagos: acc.cantidad_no_pagos + r.cantidad_no_pagos,
      cantidad_canceladas: acc.cantidad_canceladas + r.cantidad_canceladas,
      valor_gastos:      acc.valor_gastos      + r.valor_gastos,
      valor_retiros:     acc.valor_retiros     + r.valor_retiros,
      valor_ingresos:    acc.valor_ingresos    + r.valor_ingresos,
    }),
    { efectivo: 0, valor_pago: 0, meta_pagos: 0, cantidad_pagos: 0,
      cantidad_no_pagos: 0, cantidad_canceladas: 0, valor_gastos: 0,
      valor_retiros: 0, valor_ingresos: 0 },
  )

  // ── EL RESUMEN POR PAIS ────────────────────────────────────────────────────
  //
  // LOS TOTALES DE ARRIBA SUMAN PESOS ARGENTINOS CON DOLARES Y GUARANIES.
  // Eso no es un detalle de presentacion: 511.975 ARS + 1.280 USD no da
  // nada que signifique algo, y el numero resultante se lee como plata.
  //
  // Aca la plata se agrupa POR MONEDA y se muestra cada una por su lado, con
  // su propia meta. Es lo que se pidio en el mockup —"Montos por pais, no se
  // suman entre si"— y es la unica forma correcta de mirarlo mientras no haya
  // una conversion a dolares de por medio.
  const porPais = (() => {
    const m = new Map<string, {
      pais: string
      moneda: string
      recaudo: number
      meta: number
      rutas: number
    }>()
    for (const r of filteredRows) {
      const moneda = (r.moneda ?? "").trim().toUpperCase() || "—"
      const pais = capitalizarPais(r.pais, r.ciudad) || moneda
      const clave = moneda
      const acc = m.get(clave) ?? { pais, moneda, recaudo: 0, meta: 0, rutas: 0 }
      acc.recaudo += r.valor_pago
      acc.meta += r.meta_pagos
      acc.rutas += 1
      m.set(clave, acc)
    }
    return [...m.values()].sort((a, b) => a.pais.localeCompare(b.pais))
  })()

  // ── La equivalencia global en dolares ──────────────────────────────────────
  //
  // ESTA es la unica suma honesta entre paises: cada moneda se pasa a dolares
  // con la tasa de SU dia y despues se suman los dolares. Sumar los numeros
  // en bruto —lo que hacen las tarjetas de abajo— junta pesos con guaranies.
  //
  // `completa` dice si alcanzo para TODAS las monedas. Si a una le falta la
  // tasa, el total seria menor de lo real y se veria como una caida del
  // recaudo: hay que decirlo, no mostrar el numero a secas.
  const globalUsd = (() => {
    let total = 0
    const sinTasa: string[] = []
    for (const p of porPais) {
      const tasa = p.moneda === "USD" ? 1 : tasas.get(p.moneda)
      if (!tasa || tasa <= 0) {
        if (p.recaudo > 0) sinTasa.push(p.moneda)
        continue
      }
      total += p.recaudo / tasa
    }
    return { total, sinTasa, completa: sinTasa.length === 0 }
  })()

  // ── Las unidades y su estado ───────────────────────────────────────────────
  // "Sin iniciar" no sale de `rutas_diarias`: una unidad que no arranco NO
  // tiene fila ese dia. Es el resto, y por eso se calcula restando.
  const unidades = {
    total: filteredRows.length,
    abiertas: estadosDia.abiertas,
    cerradas: estadosDia.cerradas,
    sinIniciar: Math.max(filteredRows.length - estadosDia.abiertas - estadosDia.cerradas, 0),
  }

  // ── Tarjetas de resumen ────────────────────────────────────────────────────
  const cards = [
    { label: "Efectivo",    value: fmt(totals.efectivo),               icon: Wallet,        iconBg: "bg-warning-light",   iconColor: "text-icon-wallet",    textColor: "text-warning"     },
    { label: "Recaudado",   value: fmt(totals.valor_pago),             icon: DollarSign,    iconBg: "bg-success-light",   iconColor: "text-icon-cash",      textColor: "text-success"     },
    { label: "Meta",        value: fmt(totals.meta_pagos),             icon: Target,        iconBg: "bg-info-light",      iconColor: "text-icon-target",    textColor: "text-info"        },
    { label: "% Meta",      value: pctFmt(totals.valor_pago, totals.meta_pagos), icon: TrendingUp, iconBg: "bg-info-light", iconColor: "text-icon-payment", textColor: pctColorClass(totals.valor_pago, totals.meta_pagos) },
    { label: "Pagos",       value: String(totals.cantidad_pagos),      icon: CheckCircle,   iconBg: "bg-success-light",   iconColor: "text-icon-check",     textColor: "text-success"     },
    { label: "No Pagos",    value: String(totals.cantidad_no_pagos),   icon: XCircle,       iconBg: "bg-destructive/10",  iconColor: "text-destructive",    textColor: "text-destructive" },
    { label: "Canceladas",  value: String(totals.cantidad_canceladas), icon: MinusCircle,   iconBg: "bg-warning-light",   iconColor: "text-icon-wallet",    textColor: "text-warning"     },
    { label: "Gastos",      value: fmt(totals.valor_gastos),           icon: Receipt,       iconBg: "bg-destructive/10",  iconColor: "text-icon-expense",   textColor: "text-destructive" },
    { label: "Retiros",     value: fmt(totals.valor_retiros),          icon: ArrowDownCircle, iconBg: "bg-info-light",   iconColor: "text-icon-withdrawal", textColor: "text-icon-withdrawal" },
    { label: "Ingresos",    value: fmt(totals.valor_ingresos),         icon: TrendingUp,    iconBg: "bg-success-light",   iconColor: "text-icon-income",    textColor: "text-success"     },
  ]

  return (
    <div className="flex flex-col gap-3 md:gap-4">

      {/* ── Filtros ─────────────────────────────────────────────────────────── */}
      <Card className="bg-card shadow-sm border-0">
        <CardContent className="px-3 py-2">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Fecha</Label>
              <Input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                className="h-8 w-36 text-xs bg-background border-border"
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Ruta</Label>
              <Select value={rutaFilter} onValueChange={setRutaFilter}>
                <SelectTrigger className="h-8 w-44 text-xs bg-background border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las rutas</SelectItem>
                  {rutasDisponibles.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)} className="text-xs">
                      {r.nombre || `Ruta ${r.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {ciudades.length > 0 && (
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Ciudad</Label>
                <Select value={ciudadFilter} onValueChange={setCiudadFilter}>
                  <SelectTrigger className="h-8 w-36 text-xs bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    {ciudades.map((c) => (
                      <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={fetchData}
              className="h-8 gap-1.5 text-xs border-border"
            >
              <RefreshCw className="h-3 w-3" />
              Actualizar
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Resumen multimoneda ──────────────────────────────────────────────
          Una tarjeta por pais con SU plata y SU meta. Solo aparece cuando hay
          mas de una moneda en juego: con una sola, seria repetir el total de
          abajo con mas adornos. */}
      {porPais.length > 1 && (
        <Card className="bg-card shadow-sm border-0">
          <CardContent className="px-3 py-2">
            <div className="mb-2">
              <p className="text-sm font-bold text-foreground">Resumen multimoneda</p>
              <p className="text-[11px] leading-tight text-muted-foreground">
                Montos por país — no se suman entre sí
              </p>
            </div>

            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {porPais.map((p) => {
                const pct = p.meta > 0 ? Math.round((p.recaudo / p.meta) * 100) : null
                const tono =
                  pct === null ? "bg-muted-foreground"
                    : pct >= 90 ? "bg-success"
                      : pct >= 60 ? "bg-warning"
                        : "bg-destructive"
                return (
                  <div
                    key={p.moneda}
                    className="rounded-lg border border-border bg-muted/20 px-2 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <Bandera moneda={p.moneda} size={30} className="shadow-sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-bold leading-tight text-foreground">
                          {p.pais}
                        </p>
                        <p className="text-[10px] leading-tight text-muted-foreground">
                          {p.moneda} · {p.rutas} {p.rutas === 1 ? "unidad" : "unidades"}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-bold tabular-nums text-foreground">
                        {formatearMoneda(p.recaudo, p.moneda)}
                      </p>
                    </div>

                    {/* La barra y el porcentaje son CONTRA SU PROPIA META, no
                        contra las otras: comparar el recaudo argentino con el
                        paraguayo en bruto no dice nada. */}
                    <div className="mt-1 flex items-center gap-1.5">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${tono}`}
                          style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                        />
                      </div>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {pct === null ? "sin meta" : `${pct}% de su meta`}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Equivalencia global en USD ───────────────────────────────────────
          La unica suma honesta entre paises: cada moneda pasa a dolares con
          la tasa de SU dia y despues se suman los dolares. */}
      {porPais.length > 1 && globalUsd.total > 0 && (
        <Card className="border-0 bg-gradient-to-br from-sky-50 to-blue-50 shadow-sm dark:from-sky-950/40 dark:to-blue-950/40">
          <CardContent className="flex items-center gap-3 px-3 py-2.5">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-blue-600/10">
              <Coins className="h-5 w-5 text-blue-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold leading-tight text-foreground">
                Equivalencia global en USD
              </p>
              <p className="text-2xl font-bold leading-tight tabular-nums text-blue-700 dark:text-blue-300">
                USD {globalUsd.total.toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </p>
              <p className="text-[10px] leading-tight text-muted-foreground">
                Valor equivalente de todo lo recaudado · tasas del{" "}
                {fecha.split("-").reverse().join("/")}
              </p>
              {/* Si a una moneda le falta tasa, el total sale CORTO y parece
                  una caida del recaudo. Se dice cual falta. */}
              {!globalUsd.completa && (
                <p className="mt-0.5 text-[10px] font-semibold leading-tight text-amber-600">
                  No incluye {globalUsd.sinTasa.join(", ")}: sin tasa para ese día.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Unidades operativas ──────────────────────────────────────────────
          Cuantas unidades hay y en que estado arrancaron el dia. */}
      <Card className="bg-card shadow-sm border-0">
        <CardContent className="px-3 py-2">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Bike className="h-4 w-4 shrink-0 text-brand" />
            <div className="min-w-0">
              <p className="text-xs font-bold leading-tight text-foreground">
                Unidades operativas
              </p>
              <p className="text-[10px] leading-tight text-muted-foreground">
                Estado de las unidades de recaudo
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {[
              { label: "Total de unidades", valor: unidades.total, icono: Bike, tono: "text-info", fondo: "bg-info-light" },
              { label: "Unidades abiertas", valor: unidades.abiertas, icono: CheckCircle, tono: "text-success", fondo: "bg-success-light" },
              // Las que no arrancaron se muestran aparte y NO se cuentan como
              // cerradas: son cosas distintas —una cerro su caja, la otra
              // todavia no empezo— y juntarlas taparia justo lo que el admin
              // necesita ver.
              { label: unidades.sinIniciar > 0 ? "Sin iniciar" : "Unidades cerradas",
                valor: unidades.sinIniciar > 0 ? unidades.sinIniciar : unidades.cerradas,
                icono: unidades.sinIniciar > 0 ? Clock : XCircle,
                tono: unidades.sinIniciar > 0 ? "text-warning" : "text-destructive",
                fondo: unidades.sinIniciar > 0 ? "bg-warning-light" : "bg-destructive/10" },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-border bg-muted/20 px-2 py-1.5 text-center">
                <div className={`mx-auto mb-0.5 grid h-7 w-7 place-items-center rounded-full ${c.fondo}`}>
                  <c.icono className={`h-4 w-4 ${c.tono}`} />
                </div>
                <p className="text-[10px] leading-tight text-muted-foreground">{c.label}</p>
                <p className={`text-lg font-bold leading-tight tabular-nums ${c.tono}`}>{c.valor}</p>
              </div>
            ))}
          </div>

          {/* Cuando hay de las dos, la tercera caja muestra "sin iniciar" y
              las cerradas quedarian invisibles. Se dicen aparte. */}
          {unidades.sinIniciar > 0 && unidades.cerradas > 0 && (
            <p className="mt-1 text-center text-[10px] text-muted-foreground">
              {unidades.cerradas} {unidades.cerradas === 1 ? "unidad ya cerró" : "unidades ya cerraron"} su caja.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Tarjetas de resumen ──────────────────────────────────────────────── */}
      {porPais.length > 1 && (
        <div className="flex items-start gap-1.5 rounded-md border border-dashed border-amber-400 bg-amber-50/60 px-2 py-1.5 dark:bg-amber-950/20">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
            Las cifras de plata de abajo <strong>suman monedas distintas</strong> y
            no representan un valor real. Los conteos (pagos, no pagos,
            canceladas) sí son comparables. Mirá el resumen por país de arriba.
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5 md:gap-2">
        {cards.map(({ label, value, icon: Icon, iconBg, iconColor, textColor }) => (
          <Card key={label} className="bg-card shadow-sm border-0">
            <CardContent className="px-2 py-1.5 flex items-center gap-1.5">
              <div className={`h-7 w-7 rounded ${iconBg} flex items-center justify-center shrink-0`}>
                <Icon className={`h-3.5 w-3.5 ${iconColor}`} />
              </div>
              <div className="min-w-0">
                <p className="text-[9px] md:text-[10px] text-muted-foreground font-medium leading-none truncate">{label}</p>
                <p className={`text-sm md:text-base font-bold leading-tight ${textColor}`}>{value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Tabla ───────────────────────────────────────────────────────────── */}
      <Card className="bg-card shadow-sm border-0">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center items-center py-14">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center px-4">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <p className="text-xs text-destructive">{error}</p>
              <Button size="sm" variant="outline" onClick={fetchData} className="text-xs h-7">Reintentar</Button>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <p className="text-xs text-muted-foreground">Sin datos para los filtros seleccionados.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    {[
                      "Ruta", "Ciudad",
                      "Efectivo", "Recaudado", "Meta", "% Meta",
                      "Pagos", "No Pago", "Cancel.",
                      "Gastos", "Retiros", "Ingresos",
                      "Últ. Mov.",
                    ].map((h, i) => (
                      <TableHead
                        key={h}
                        className={`text-[9px] md:text-[10px] font-bold uppercase tracking-wide text-muted-foreground px-2 py-2 whitespace-nowrap ${i >= 2 ? "text-right" : ""} ${[6,7,8,12].includes(i) ? "text-center" : ""}`}
                      >
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((row) => {
                    const horaFmt = row.hora_ultimo_movimiento
                      ? row.hora_ultimo_movimiento.includes("T")
                        ? new Date(row.hora_ultimo_movimiento).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
                        : row.hora_ultimo_movimiento.slice(0, 5)
                      : "—"

                    return (
                      <TableRow key={row.ruta} className="hover:bg-muted/20 border-b border-border/50">
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 font-semibold text-foreground whitespace-nowrap">
                          {row.ruta_nombre}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-muted-foreground whitespace-nowrap">
                          {row.ciudad ?? "—"}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-right font-medium text-warning whitespace-nowrap">
                          {fmt(row.efectivo)}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-right font-medium text-success whitespace-nowrap">
                          {fmt(row.valor_pago)}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-right text-muted-foreground whitespace-nowrap">
                          {fmt(row.meta_pagos)}
                        </TableCell>
                        <TableCell className={`text-[10px] md:text-xs px-2 py-1.5 text-center whitespace-nowrap ${pctColorClass(row.valor_pago, row.meta_pagos)}`}>
                          {pctFmt(row.valor_pago, row.meta_pagos)}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-center font-semibold text-success">
                          {row.cantidad_pagos}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-center font-semibold text-destructive">
                          {row.cantidad_no_pagos}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-center font-semibold text-warning">
                          {row.cantidad_canceladas}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-right text-destructive whitespace-nowrap">
                          {fmt(row.valor_gastos)}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-right text-icon-withdrawal whitespace-nowrap">
                          {fmt(row.valor_retiros)}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-right text-icon-income whitespace-nowrap">
                          {fmt(row.valor_ingresos)}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-2 py-1.5 text-center text-muted-foreground whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-2.5 w-2.5" />
                            {horaFmt}
                          </span>
                        </TableCell>
                      </TableRow>
                    )
                  })}

                  {/* Fila de totales */}
                  {filteredRows.length > 1 && (
                    <TableRow className="bg-muted/50 border-t-2 border-border font-bold">
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 font-bold text-foreground" colSpan={2}>
                        Total — {filteredRows.length} rutas
                      </TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 text-right font-bold text-warning whitespace-nowrap">{fmt(totals.efectivo)}</TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 text-right font-bold text-success whitespace-nowrap">{fmt(totals.valor_pago)}</TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 text-right text-muted-foreground whitespace-nowrap">{fmt(totals.meta_pagos)}</TableCell>
                      <TableCell className={`text-[10px] md:text-xs px-2 py-2 text-center whitespace-nowrap ${pctColorClass(totals.valor_pago, totals.meta_pagos)}`}>{pctFmt(totals.valor_pago, totals.meta_pagos)}</TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 text-center font-bold text-success">{totals.cantidad_pagos}</TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 text-center font-bold text-destructive">{totals.cantidad_no_pagos}</TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 text-center font-bold text-warning">{totals.cantidad_canceladas}</TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 text-right font-bold text-destructive whitespace-nowrap">{fmt(totals.valor_gastos)}</TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 text-right font-bold text-icon-withdrawal whitespace-nowrap">{fmt(totals.valor_retiros)}</TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2 text-right font-bold text-icon-income whitespace-nowrap">{fmt(totals.valor_ingresos)}</TableCell>
                      <TableCell className="text-[10px] md:text-xs px-2 py-2" />
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
