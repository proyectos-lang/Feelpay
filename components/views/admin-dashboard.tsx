"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
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
  Receipt, ArrowDownCircle, Clock,
} from "lucide-react"

type RutaInfo = { id: number; nombre: string; ciudad: string | null }

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
}

interface AdminDashboardProps {
  currentUserId?: number | string | null
}

const fmt = (n: number) => `$${Math.round(n).toLocaleString("es-CO")}`
const pctFmt = (val: number, meta: number) =>
  meta > 0 ? `${Math.round((val / meta) * 100)}%` : "—"

const pctColorClass = (val: number, meta: number) => {
  if (meta <= 0) return "text-muted-foreground"
  const p = (val / meta) * 100
  if (p >= 90) return "text-success font-bold"
  if (p >= 60) return "text-warning font-semibold"
  return "text-destructive font-semibold"
}

const todayColombia = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())

export function AdminDashboard({ currentUserId }: AdminDashboardProps) {
  const [fecha, setFecha] = useState(todayColombia)
  const [rutaFilter, setRutaFilter] = useState("all")
  const [ciudadFilter, setCiudadFilter] = useState("all")

  const [rutasDisponibles, setRutasDisponibles] = useState<RutaInfo[]>([])
  const [rows, setRows] = useState<ResumenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ── Cargar rutas accesibles ────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const supabase = createClient()
      try {
        if (currentUserId) {
          const { data } = await supabase
            .from("usuario_rutas")
            .select("rutas:ruta_id(id, nombre, ciudad)")
            .eq("usuario_id", currentUserId)
          const rutas = (data ?? [])
            .map((r: any) => r.rutas)
            .filter(Boolean)
            .sort((a: any, b: any) => a.id - b.id) as RutaInfo[]
          setRutasDisponibles(rutas)
        } else {
          const { data } = await supabase
            .from("rutas")
            .select("id, nombre, ciudad")
            .order("id", { ascending: true })
          setRutasDisponibles((data ?? []) as RutaInfo[])
        }
      } catch (e) {
        console.error("[v0] AdminDashboard rutas error:", e)
      }
    }
    load()
  }, [currentUserId])

  // ── Cargar resumen_pagos_diarios ──────────────────────────────────────────
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

      const fullSelect =
        "ruta, efectivo, valor_pago, meta_pagos, cantidad_pagos, cantidad_no_pagos, cantidad_canceladas, valor_gastos, valor_retiros, valor_ingresos, hora_ultimo_movimiento"

      let data: any[] | null = null

      const res1 = await supabase
        .from("resumen_pagos_diarios")
        .select(fullSelect)
        .eq("fecha_pago", fecha)
        .in("ruta", rutaIds)
        .order("ruta", { ascending: true })

      if (!res1.error) {
        data = res1.data
      } else {
        console.warn("[v0] AdminDashboard full select failed, retrying base:", res1.error.message)
        const res2 = await supabase
          .from("resumen_pagos_diarios")
          .select("ruta, efectivo, valor_pago, meta_pagos, valor_gastos, valor_retiros, valor_ingresos")
          .eq("fecha_pago", fecha)
          .in("ruta", rutaIds)
          .order("ruta", { ascending: true })
        if (res2.error) throw res2.error
        data = res2.data
      }

      setRows(
        (data ?? []).map((d: any) => {
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

      {/* ── Tarjetas de resumen ──────────────────────────────────────────────── */}
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
