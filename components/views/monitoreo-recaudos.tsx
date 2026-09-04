"use client"

/**
 * components/views/monitoreo-recaudos.tsx
 * ---------------------------------------------------------------------------
 * MONITOREO DE RECAUDOS — la tabla día por día que revisa secretaría.
 *
 * Una fila por ruta y fecha, diecinueve columnas, para ver cómo viene el
 * recaudo de una ruta a lo largo de un mes.
 *
 * TODO SALE DE `vista_monitoreo_recaudos` (script 099). Acá no se calcula ni
 * un número: si esta pantalla hiciera sus propias cuentas, tarde o temprano
 * diría algo distinto del cierre que el cobrador firmó. Lo único que se hace
 * es formatear y pintar.
 *
 * COMPACTA DE VERDAD. Diecinueve columnas no caben en un teléfono ni en un
 * portátil: la tabla scrollea de lado dentro de su propio contenedor —el
 * `overflow-x-auto`— y las dos primeras columnas quedan fijas a la izquierda,
 * porque perder de vista la ruta y la fecha mientras se mira la columna 15 es
 * quedarse sin saber de qué fila se está hablando.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Loader2, RefreshCw, TrendingUp, XCircle } from "lucide-react"
import { todayColombia } from "@/lib/gestion-core"
import { fmtFecha } from "@/lib/colombia-date"

/** Una fila de `vista_monitoreo_recaudos`. Los nombres son los de la vista. */
type FilaRecaudo = {
  unidad: number
  fecha: string
  cartera_final: number | null
  clientes_mora_mayor_7: number | null
  frecuencia_no_diaria: number | null
  renovaciones: number | null
  total_recaudo: number | null
  recaudo_sin_canceladas: number | null
  valor_canceladas: number | null
  pct_recaudo: number | null
  pct_clientes_pagos: number | null
  pagos: number | null
  no_pagos: number | null
  total_clientes: number | null
  clientes_cancelados: number | null
  cantidad_ventas: number | null
  valor_ventas: number | null
  numero_gastos: number | null
  valor_gastos: number | null
}

interface Props {
  /**
   * Quién está mirando. Sin esto la pantalla mostraría todas las rutas a
   * cualquiera — mismo criterio que el Monitoreo de Rutas.
   */
  currentUser?: { id: number | string; rol?: string | null } | null
}

/** Quiénes ven TODAS las rutas. El resto ve las suyas y nada más. */
const ROLES_QUE_VEN_TODO = new Set(["admin", "administrador", "secretaria", "secretario"])

const money = (v: number | null | undefined) =>
  `$${Math.round(Number(v) || 0).toLocaleString("es-CO")}`
const entero = (v: number | null | undefined) => String(Math.round(Number(v) || 0))
const pct = (v: number | null | undefined) => `${Math.round(Number(v) || 0)} %`

/** El primer día del mes de una fecha "YYYY-MM-DD". */
const primeroDelMes = (iso: string) => `${iso.slice(0, 7)}-01`

/**
 * LAS DIECINUEVE COLUMNAS, en el orden en que se pidieron.
 *
 * Viven en un arreglo y no escritas a mano en el `<thead>` y otra vez en el
 * `<tbody>`: con dos listas, agregar una columna obliga a acordarse de tocar
 * dos sitios, y cualquier olvido corre los encabezados respecto de los datos.
 */
const COLUMNAS: {
  clave: keyof FilaRecaudo
  titulo: string
  fmt: (v: number | null | undefined) => string
  /** Cifra de plata: va en negrita para separarla de los conteos. */
  plata?: boolean
}[] = [
  { clave: "cartera_final",          titulo: "Cartera final",          fmt: money, plata: true },
  { clave: "total_recaudo",          titulo: "Total Recaudo",          fmt: money, plata: true },
  { clave: "recaudo_sin_canceladas", titulo: "Recaudo sin canceladas", fmt: money, plata: true },
  { clave: "valor_canceladas",       titulo: "Valor canceladas",       fmt: money, plata: true },
  { clave: "pct_recaudo",            titulo: "% Recaudo",              fmt: pct },
  { clave: "pct_clientes_pagos",     titulo: "% Clientes pagos",       fmt: pct },
  { clave: "pagos",                  titulo: "Pagos",                  fmt: entero },
  { clave: "no_pagos",               titulo: "No pagos",               fmt: entero },
  { clave: "total_clientes",         titulo: "Total clientes",         fmt: entero },
  { clave: "clientes_mora_mayor_7",  titulo: "Clientes en mora +7 días", fmt: entero },
  { clave: "clientes_cancelados",    titulo: "Clientes cancelados",    fmt: entero },
  { clave: "renovaciones",           titulo: "Renovaciones",           fmt: entero },
  { clave: "cantidad_ventas",        titulo: "Cantidad ventas",        fmt: entero },
  { clave: "valor_ventas",           titulo: "Valor ventas",           fmt: money, plata: true },
  { clave: "numero_gastos",          titulo: "# de Gastos",            fmt: entero },
  { clave: "valor_gastos",           titulo: "Valor gastos",           fmt: money, plata: true },
  { clave: "frecuencia_no_diaria",   titulo: "Frecuencia no diaria",   fmt: entero },
]

export function MonitoreoRecaudos({ currentUser }: Props) {
  const hoy = todayColombia()
  // Arranca en el mes en curso: es lo que se mira el 99% de las veces.
  const [desde, setDesde] = useState(primeroDelMes(hoy))
  const [hasta, setHasta] = useState(hoy)
  const [ruta, setRuta] = useState<string>("todas")

  const [filas, setFilas] = useState<FilaRecaudo[]>([])
  const [rutas, setRutas] = useState<number[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /**
   * Qué rutas puede ver esta persona. `null` = todas.
   *
   * Se resuelve antes de consultar: un instante sin datos es preferible a un
   * instante mostrando rutas ajenas.
   */
  const [rutasPermitidas, setRutasPermitidas] = useState<number[] | null>(null)
  const [resolviendoPermiso, setResolviendoPermiso] = useState(true)

  useEffect(() => {
    let vigente = true
    const resolver = async () => {
      setResolviendoPermiso(true)
      try {
        const rol = (currentUser?.rol ?? "").toLowerCase()
        if (ROLES_QUE_VEN_TODO.has(rol)) {
          if (vigente) setRutasPermitidas(null)
          return
        }
        if (!currentUser?.id) {
          if (vigente) setRutasPermitidas([])
          return
        }
        const { data } = await createClient()
          .from("usuario_rutas")
          .select("ruta_id")
          .eq("usuario_id", currentUser.id)
        if (vigente) {
          setRutasPermitidas(((data ?? []) as { ruta_id: number }[]).map((r) => Number(r.ruta_id)))
        }
      } catch (e) {
        console.error("[v0] MonitoreoRecaudos permisos:", e)
        if (vigente) setRutasPermitidas([])
      } finally {
        if (vigente) setResolviendoPermiso(false)
      }
    }
    void resolver()
    return () => { vigente = false }
  }, [currentUser?.id, currentUser?.rol])

  const cargar = useCallback(async () => {
    if (resolviendoPermiso) return
    setCargando(true)
    setError(null)
    try {
      let q = createClient()
        .from("vista_monitoreo_recaudos")
        .select("*")
        .gte("fecha", desde)
        .lte("fecha", hasta)
        .order("fecha", { ascending: false })
        .order("unidad", { ascending: true })

      // `null` = ve todas. Un arreglo = solo esas. Vacío = ninguna, y `.in()`
      // con lista vacía devuelve cero filas, que es lo correcto.
      if (rutasPermitidas !== null) q = q.in("unidad", rutasPermitidas)
      if (ruta !== "todas") q = q.eq("unidad", Number(ruta))

      const { data, error: err } = await q
      if (err) {
        // 42P01 = la vista no existe: falta correr el script 099. Se dice con
        // esas palabras en vez de un error de Postgres que nadie va a saber
        // interpretar.
        const falta = (err as { code?: string }).code === "42P01"
        console.error("[v0] vista_monitoreo_recaudos:", err.message)
        setError(falta
          ? "Falta correr el script 099 en la base. Sin él esta pantalla no tiene de dónde leer."
          : err.message)
        setFilas([])
        return
      }
      const rows = (data ?? []) as FilaRecaudo[]
      setFilas(rows)
      // Las rutas del selector salen de lo que HAY, no de una lista aparte:
      // así nunca se ofrece una ruta que no tiene filas en el rango.
      setRutas([...new Set(rows.map((r) => Number(r.unidad)))].sort((a, b) => a - b))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error("[v0] MonitoreoRecaudos:", msg)
      setError(msg)
      setFilas([])
    } finally {
      setCargando(false)
    }
  }, [desde, hasta, ruta, rutasPermitidas, resolviendoPermiso])

  useEffect(() => { void cargar() }, [cargar])

  /**
   * El pie de la tabla.
   *
   * La plata se SUMA y los porcentajes se RECALCULAN sobre esos totales: un
   * promedio de porcentajes le daría el mismo peso a un día de $30.000 que a
   * uno de $3.000.000. Los conteos de clientes NO se suman —un cliente que
   * pagó los veinte días no son veinte clientes— y por eso van vacíos.
   */
  const total = useMemo(() => {
    const suma = (k: keyof FilaRecaudo) =>
      filas.reduce((acc, f) => acc + (Number(f[k]) || 0), 0)
    return {
      recaudo: suma("total_recaudo"),
      sinCanceladas: suma("recaudo_sin_canceladas"),
      canceladas: suma("valor_canceladas"),
      pagos: suma("pagos"),
      noPagos: suma("no_pagos"),
      cancelados: suma("clientes_cancelados"),
      renovaciones: suma("renovaciones"),
      cantVentas: suma("cantidad_ventas"),
      valVentas: suma("valor_ventas"),
      numGastos: suma("numero_gastos"),
      valGastos: suma("valor_gastos"),
    }
  }, [filas])

  const valorDeTotal = (clave: keyof FilaRecaudo): string | null => {
    switch (clave) {
      case "total_recaudo":          return money(total.recaudo)
      case "recaudo_sin_canceladas": return money(total.sinCanceladas)
      case "valor_canceladas":       return money(total.canceladas)
      case "pagos":                  return entero(total.pagos)
      case "no_pagos":               return entero(total.noPagos)
      case "clientes_cancelados":    return entero(total.cancelados)
      case "renovaciones":           return entero(total.renovaciones)
      case "cantidad_ventas":        return entero(total.cantVentas)
      case "valor_ventas":           return money(total.valVentas)
      case "numero_gastos":          return entero(total.numGastos)
      case "valor_gastos":           return money(total.valGastos)
      // Cartera, mora, total de clientes y frecuencia son FOTOS de un día:
      // sumarlas a lo largo del mes no significa nada.
      default:                       return null
    }
  }

  const irAlMes = (delta: number) => {
    const [a, m] = desde.slice(0, 7).split("-").map(Number)
    const d = new Date(a, m - 1 + delta, 1)
    const ini = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`
    const fin = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    const finIso = `${fin.getFullYear()}-${String(fin.getMonth() + 1).padStart(2, "0")}-${String(fin.getDate()).padStart(2, "0")}`
    setDesde(ini)
    // No se pide más allá de hoy: el futuro no tiene recaudo.
    setHasta(finIso > hoy ? hoy : finIso)
  }

  return (
    <div className="space-y-3">
      {/* ── Encabezado y filtros ─────────────────────────────────────────── */}
      <div className="rounded-b-2xl bg-brand-gradient px-4 pt-4 pb-3 text-brand-foreground shadow-lg">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5" />
          <h1 className="text-xl font-bold tracking-tight">Monitoreo de Recaudos</h1>
        </div>
        <p className="mt-0.5 text-[11px] text-brand-foreground/80">
          Cómo viene el recaudo de cada ruta, día por día
        </p>
      </div>

      <Card className="border-border/60 shadow-steel">
        <CardContent className="flex flex-wrap items-end gap-2 p-3">
          <div className="space-y-1">
            <Label htmlFor="mr-ruta" className="text-[11px] font-bold">Ruta</Label>
            <Select value={ruta} onValueChange={setRuta}>
              <SelectTrigger id="mr-ruta" className="h-9 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todas" className="text-xs">Todas</SelectItem>
                {rutas.map((r) => (
                  <SelectItem key={r} value={String(r)} className="text-xs">Ruta {r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="mr-desde" className="text-[11px] font-bold">Desde</Label>
            <Input
              id="mr-desde" type="date" value={desde} max={hasta}
              onChange={(e) => setDesde(e.target.value)}
              className="h-9 w-[150px] text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mr-hasta" className="text-[11px] font-bold">Hasta</Label>
            <Input
              id="mr-hasta" type="date" value={hasta} min={desde} max={hoy}
              onChange={(e) => setHasta(e.target.value)}
              className="h-9 w-[150px] text-xs"
            />
          </div>

          {/* Un mes entero de un toque: es como se mira este informe. */}
          <div className="flex items-end gap-1.5">
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => irAlMes(0)}>
              Este mes
            </Button>
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => irAlMes(-1)}>
              Mes anterior
            </Button>
            <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => void cargar()}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="text-xs">Actualizar</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── La tabla ─────────────────────────────────────────────────────── */}
      {cargando ? (
        <div className="flex items-center justify-center gap-2 py-14 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Cargando…</span>
        </div>
      ) : error ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <XCircle className="h-9 w-9 text-destructive" />
            <p className="font-semibold">No se pudo cargar el monitoreo</p>
            <p className="max-w-md text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void cargar()}>Reintentar</Button>
          </CardContent>
        </Card>
      ) : filas.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <TrendingUp className="h-9 w-9 text-muted-foreground" />
            <p className="font-semibold">Sin movimiento en ese período</p>
            <p className="text-sm text-muted-foreground">
              {ruta === "todas"
                ? `No hay días con registro entre ${fmtFecha(desde)} y ${fmtFecha(hasta)}.`
                : `La ruta ${ruta} no tiene días con registro entre ${fmtFecha(desde)} y ${fmtFecha(hasta)}.`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-border/60 shadow-steel">
          {/* El scroll horizontal vive ACÁ, en su propio contenedor: si lo
              tuviera el `body`, toda la app se arrastraría de lado. */}
          <div className="overflow-x-auto">
            <table className="w-max min-w-full border-collapse text-[11px] tabular-nums">
              <thead>
                <tr className="bg-brand text-brand-foreground">
                  {/* UNID y Date quedan FIJAS: mirando la columna 15 sin ellas
                      no se sabe de qué ruta ni de qué día se está hablando. */}
                  <th className="sticky left-0 z-20 bg-brand px-2 py-2 text-left font-bold">UNID</th>
                  <th className="sticky left-[46px] z-20 bg-brand px-2 py-2 text-left font-bold">Fecha</th>
                  {COLUMNAS.map((c) => (
                    <th key={c.clave} className="whitespace-nowrap px-2 py-2 text-right font-bold">
                      {c.titulo}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filas.map((f, i) => (
                  <tr
                    key={`${f.unidad}-${f.fecha}`}
                    className={`border-b border-border ${i % 2 === 0 ? "bg-card" : "bg-muted/40"}`}
                  >
                    <td className={`sticky left-0 z-10 px-2 py-1.5 font-bold text-brand ${
                      i % 2 === 0 ? "bg-card" : "bg-muted"
                    }`}>
                      {f.unidad}
                    </td>
                    <td className={`sticky left-[46px] z-10 whitespace-nowrap px-2 py-1.5 font-semibold ${
                      i % 2 === 0 ? "bg-card" : "bg-muted"
                    }`}>
                      {fmtFecha(f.fecha)}
                    </td>
                    {COLUMNAS.map((c) => (
                      <td
                        key={c.clave}
                        className={`whitespace-nowrap px-2 py-1.5 text-right ${
                          c.plata ? "font-semibold text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {c.fmt(f[c.clave] as number | null)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-brand bg-muted font-bold">
                  <td className="sticky left-0 z-10 bg-muted px-2 py-2">—</td>
                  <td className="sticky left-[46px] z-10 whitespace-nowrap bg-muted px-2 py-2">
                    {filas.length} {filas.length === 1 ? "día" : "días"}
                  </td>
                  {COLUMNAS.map((c) => (
                    <td key={c.clave} className="whitespace-nowrap px-2 py-2 text-right">
                      {valorDeTotal(c.clave) ?? ""}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      {/* Por qué el pie no suma todo. Sin esta línea, ver "Total clientes" en
          blanco se lee como un dato que falta. */}
      {filas.length > 0 && (
        <p className="px-1 text-[11px] leading-snug text-muted-foreground">
          El total suma la plata y los movimientos del período. La cartera, la mora, el total
          de clientes y la frecuencia no se suman: son la foto de un día, y sumarlas a lo largo
          del mes contaría al mismo cliente una vez por día.
        </p>
      )}
    </div>
  )
}
