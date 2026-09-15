"use client"

/**
 * Reporte Gerencial.
 *
 * UNA LÍNEA POR ADMINISTRADOR, agrupadas por país, contando CUÁNTAS DE SUS
 * UNIDADES cerraron el día —o el rango— en cada banda de recaudo:
 *
 *      % 0-49     mal:      recaudó menos de la mitad de lo pretendido
 *      % 49-60    regular
 *      % 60-100   bien
 *
 * El número de cada casilla son UNIDADES, no plata. Es la diferencia con el
 * Reporte del Administrador, que lista cada ruta con sus cifras: acá se mira
 * de un vistazo cuántas unidades tiene flojas cada administrador.
 *
 * CUANDO EL RANGO ES DE VARIOS DÍAS, cada ruta cuenta UNA vez, con el
 * porcentaje de TODO el rango (lo cobrado sobre lo pretendido en esos días).
 * Contar un renglón por día inflaría los totales: una ruta con cinco días
 * aparecería cinco veces y "cuántas unidades cerraron mal" dejaría de
 * significar unidades.
 *
 * DE DÓNDE SALE CADA NÚMERO
 *   El % es `valor_pago / meta_pagos` de `resumen_diario_v2`, exactamente el
 *   mismo que muestra el Reporte del Administrador. Los gastos son
 *   `valor_gastos`. El administrador de cada ruta es el usuario con rol
 *   admin que la tenga asignada en `usuario_rutas` — la misma pantalla de
 *   Asignaciones de siempre.
 *
 * QUIÉN LO VE. Un GERENTE ve solo a los administradores que tiene asignados
 * (`gerente_admins`, scripts/116). Admin y secretaría ven todos: son quienes
 * arman y revisan la operación.
 *
 * Es de SOLO LECTURA.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertTriangle, BarChart2, Download, RefreshCw } from "lucide-react"
import { getSupabaseSafe } from "@/lib/api-helper"
import { todayColombia } from "@/lib/colombia-date"
import { useToast } from "@/hooks/use-toast"

/**
 * LAS TRES BANDAS.
 *
 * Los bordes se leen como en la planilla: hasta 49 es la primera, de 49 a 60
 * la segunda, de 60 en adelante la tercera. Un 49 exacto cae en la segunda y
 * un 60 exacto en la tercera — si no, un valor justo en el borde no entraría
 * en ninguna y la suma de las tres no daría el total de unidades.
 */
const BANDAS = [
  { id: "baja", etiqueta: "% 0-49", min: 0, max: 49 },
  { id: "media", etiqueta: "% 49-60", min: 49, max: 60 },
  { id: "alta", etiqueta: "% 60-100", min: 60, max: Infinity },
] as const

type BandaId = (typeof BANDAS)[number]["id"]

function bandaDe(pct: number): BandaId {
  if (pct < 49) return "baja"
  if (pct < 60) return "media"
  return "alta"
}

/** Un administrador dentro de un país. */
interface FilaAdmin {
  adminId: number
  nombre: string
  pais: string
  baja: number
  media: number
  alta: number
  /** Unidades con meta en 0 en el rango: no se les puede sacar porcentaje. */
  sinMeta: number
  gastos: number
  unidades: number
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("es-CO")
}

export function ReporteGerencial() {
  const { toast } = useToast()
  const hoy = todayColombia()

  const [desde, setDesde] = useState(hoy)
  const [hasta, setHasta] = useState(hoy)
  const [filas, setFilas] = useState<FilaAdmin[]>([])
  const [huerfanas, setHuerfanas] = useState<{ ruta: number; nombre: string }[]>([])
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      const sb = await getSupabaseSafe()

      const [resResumen, resRutas, resAsign, resUsuarios] = await Promise.all([
        sb
          .from("resumen_diario_v2")
          .select("fecha_pago, ruta, meta_pagos, valor_pago, valor_gastos")
          .gte("fecha_pago", desde)
          .lte("fecha_pago", hasta),
        sb.from("rutas").select("id, nombre, pais"),
        sb.from("usuario_rutas").select("usuario_id, ruta_id"),
        sb.from("usuarios").select("id, nombre, rol, activo"),
      ])
      if (resResumen.error) throw new Error(resResumen.error.message)

      // ── Quién es gerente y a quién ve ───────────────────────────────────
      // La tabla puede no existir todavía (script 116 sin correr): en ese
      // caso se falla ABIERTO —el gerente ve todos los administradores— en
      // vez de dejar el reporte en blanco sin explicar por qué.
      let sesion: { id?: number; rol?: string } = {}
      try {
        sesion = JSON.parse(localStorage.getItem("currentUser") ?? "{}")
      } catch {
        /* sin sesión legible: se tratan todos */
      }
      const esGerente = ["gerencia", "gerente"].includes((sesion.rol ?? "").toLowerCase())

      let visiblesParaMi: Set<number> | null = null
      if (esGerente && sesion.id != null) {
        const { data, error } = await sb
          .from("gerente_admins")
          .select("admin_id")
          .eq("gerente_id", sesion.id)
        if (!error && data) {
          visiblesParaMi = new Set(
            (data as unknown as { admin_id: number }[]).map((x) => x.admin_id),
          )
        }
      }

      const rutas = new Map(
        ((resRutas.data ?? []) as unknown as {
          id: number
          nombre: string | null
          pais: string | null
        }[]).map((r) => [r.id, r]),
      )

      const usuarios = new Map(
        ((resUsuarios.data ?? []) as unknown as {
          id: number
          nombre: string | null
          rol: string | null
        }[]).map((u) => [u.id, u]),
      )

      // El administrador de cada ruta: el usuario con rol admin que la tenga
      // asignada. Una ruta puede tener más de uno; se cuenta para todos, que
      // es lo correcto si dos administradores la comparten.
      const adminsDeRuta = new Map<number, number[]>()
      for (const a of (resAsign.data ?? []) as unknown as {
        usuario_id: number
        ruta_id: number
      }[]) {
        const u = usuarios.get(a.usuario_id)
        const rol = (u?.rol ?? "").toLowerCase()
        if (rol !== "admin" && rol !== "administrador") continue
        if (visiblesParaMi && !visiblesParaMi.has(a.usuario_id)) continue
        const lista = adminsDeRuta.get(a.ruta_id)
        if (lista) lista.push(a.usuario_id)
        else adminsDeRuta.set(a.ruta_id, [a.usuario_id])
      }

      // ── Una ruta cuenta UNA vez en todo el rango ────────────────────────
      const n = (v: unknown) => Number(v) || 0
      const porRuta = new Map<number, { meta: number; cobrado: number; gastos: number }>()
      for (const r of (resResumen.data ?? []) as unknown as Record<string, unknown>[]) {
        const rid = Number(r.ruta)
        const acc = porRuta.get(rid) ?? { meta: 0, cobrado: 0, gastos: 0 }
        acc.meta += n(r.meta_pagos)
        acc.cobrado += n(r.valor_pago)
        acc.gastos += n(r.valor_gastos)
        porRuta.set(rid, acc)
      }

      const acumulado = new Map<string, FilaAdmin>()
      const sueltas: { ruta: number; nombre: string }[] = []

      for (const [rid, v] of porRuta) {
        const admins = adminsDeRuta.get(rid) ?? []
        if (admins.length === 0) {
          // Si hay filtro de gerente, una ruta de otro administrador no es
          // "huérfana": simplemente no es suya. Solo se avisa cuando NADIE
          // la tiene asignada.
          const tieneAlguno = ((resAsign.data ?? []) as unknown as {
            usuario_id: number
            ruta_id: number
          }[]).some((a) => {
            const rol = (usuarios.get(a.usuario_id)?.rol ?? "").toLowerCase()
            return a.ruta_id === rid && (rol === "admin" || rol === "administrador")
          })
          if (!tieneAlguno) {
            sueltas.push({ ruta: rid, nombre: rutas.get(rid)?.nombre ?? String(rid) })
          }
          continue
        }

        const pct = v.meta > 0 ? Math.round((v.cobrado * 100) / v.meta) : null
        for (const adminId of admins) {
          const u = usuarios.get(adminId)
          const pais = (rutas.get(rid)?.pais ?? "—").trim() || "—"
          // La clave incluye el país: el mismo administrador con rutas en dos
          // países sale en los dos bloques, como en la planilla. Se normaliza
          // a minúsculas porque en la base conviven "Argentina" y "ARGENTINA"
          // y si no, el mismo país abriría dos bloques.
          const clave = `${adminId}|${pais.toLowerCase()}`
          let fila = acumulado.get(clave)
          if (!fila) {
            fila = {
              adminId,
              nombre: u?.nombre ?? `#${adminId}`,
              pais,
              baja: 0,
              media: 0,
              alta: 0,
              sinMeta: 0,
              gastos: 0,
              unidades: 0,
            }
            acumulado.set(clave, fila)
          }

          if (pct === null) fila.sinMeta += 1
          else fila[bandaDe(pct)] += 1
          fila.gastos += v.gastos
          fila.unidades += 1
        }
      }

      setFilas(
        [...acumulado.values()].sort(
          (a, b) => a.pais.localeCompare(b.pais) || a.nombre.localeCompare(b.nombre),
        ),
      )
      setHuerfanas(sueltas.sort((a, b) => a.ruta - b.ruta))
    } catch (err) {
      console.error("[v0] Reporte Gerencial:", err)
      setError(err instanceof Error ? err.message : "No se pudo cargar el reporte")
      setFilas([])
      setHuerfanas([])
    } finally {
      setCargando(false)
    }
  }, [desde, hasta])

  useEffect(() => {
    void cargar()
  }, [cargar])

  /** Las filas agrupadas por país, que es como se lee la planilla. */
  const porPais = useMemo(() => {
    const m = new Map<string, FilaAdmin[]>()
    for (const f of filas) {
      const lista = m.get(f.pais)
      if (lista) lista.push(f)
      else m.set(f.pais, [f])
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filas])

  const granTotal = useMemo(() => {
    const s = (fn: (f: FilaAdmin) => number) => filas.reduce((acc, f) => acc + fn(f), 0)
    return {
      baja: s((f) => f.baja),
      media: s((f) => f.media),
      alta: s((f) => f.alta),
      sinMeta: s((f) => f.sinMeta),
      gastos: s((f) => f.gastos),
      unidades: s((f) => f.unidades),
    }
  }, [filas])

  const exportarCsv = () => {
    if (filas.length === 0) return
    const cab = ["País", "Administrador", "% 0-49", "% 49-60", "% 60-100", "Sin meta", "Unidades", "Gastos"]
    const lineas = filas.map((f) =>
      [f.pais, f.nombre, f.baja, f.media, f.alta, f.sinMeta, f.unidades, Math.round(f.gastos)].join(";"),
    )
    const total = ["", "GRAN TOTAL", granTotal.baja, granTotal.media, granTotal.alta,
                   granTotal.sinMeta, granTotal.unidades, Math.round(granTotal.gastos)].join(";")
    const csv = [cab.join(";"), ...lineas, total].join("\n")
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `reporte-gerencial_${desde}_${hasta}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: "Reporte descargado", description: `${filas.length} administradores.` })
  }

  const celda = (n: number, tono: string) => (
    <td className={`border px-2 py-1 text-center font-bold tabular-nums ${n > 0 ? tono : ""}`}>
      {n}
    </td>
  )

  return (
    <div className="space-y-3">
      {/* ── Filtros ──────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Desde</Label>
              <Input
                type="date"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
                className="h-9 w-[150px] text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Hasta</Label>
              <Input
                type="date"
                value={hasta}
                onChange={(e) => setHasta(e.target.value)}
                className="h-9 w-[150px] text-xs"
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
              disabled={filas.length === 0}
              className="h-9 gap-1.5 text-xs"
            >
              <Download className="h-3.5 w-3.5" />
              Exportar
            </Button>
            <Badge variant="secondary" className="h-9 rounded-md px-2.5 text-xs">
              {granTotal.unidades} {granTotal.unidades === 1 ? "unidad" : "unidades"}
            </Badge>
          </div>
          {desde !== hasta && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              En un rango de varios días cada unidad cuenta <strong>una vez</strong>, con el
              porcentaje de todo el rango.
            </p>
          )}
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

      {/* LAS UNIDADES SIN ADMINISTRADOR NO SE ESCONDEN.
          Si una ruta no está asignada a ningún administrador no aparece en
          ninguna línea, y el reporte saldría cuadrado pero incompleto. Se
          avisa arriba, con nombre y número, para que se pueda asignar. */}
      {!cargando && huerfanas.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/40">
          <CardContent className="p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="text-[11px] leading-relaxed">
                <span className="font-semibold">
                  {huerfanas.length}{" "}
                  {huerfanas.length === 1 ? "unidad no está" : "unidades no están"} en ninguna
                  línea:
                </span>{" "}
                {huerfanas.map((h) => `${h.ruta} (${h.nombre})`).join(" · ")}.
                <div className="mt-0.5 text-muted-foreground">
                  No tienen un administrador asignado. Se arregla en Usuarios y Rutas →
                  Asignaciones, marcándole esas unidades al administrador que corresponda.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {!cargando && !error && filas.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center">
            <BarChart2 className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-xs text-muted-foreground">
              No hay unidades con administrador asignado en ese rango.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── La tabla, por país ────────────────────────────────────────────── */}
      {!cargando && !error && filas.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-[11px]">
                <tbody>
                  {porPais.map(([pais, lista]) => {
                    const sub = {
                      baja: lista.reduce((s, f) => s + f.baja, 0),
                      media: lista.reduce((s, f) => s + f.media, 0),
                      alta: lista.reduce((s, f) => s + f.alta, 0),
                      gastos: lista.reduce((s, f) => s + f.gastos, 0),
                    }
                    return (
                      <>
                        {/* El país como banda, igual que en la planilla */}
                        <tr key={`p-${pais}`} className="bg-slate-200 dark:bg-slate-700">
                          <td
                            colSpan={5}
                            className="border px-2 py-1.5 text-center text-xs font-bold uppercase tracking-wide"
                          >
                            {pais}
                          </td>
                        </tr>
                        <tr key={`h-${pais}`} className="bg-muted text-muted-foreground">
                          <th className="border px-2 py-1 text-left font-semibold">Administrador</th>
                          {BANDAS.map((b) => (
                            <th key={b.id} className="border px-2 py-1 text-center font-semibold">
                              {b.etiqueta}
                            </th>
                          ))}
                          <th className="border px-2 py-1 text-right font-semibold">Gastos</th>
                        </tr>
                        {lista.map((f) => (
                          <tr key={`${pais}-${f.adminId}`} className="hover:bg-muted/40">
                            <td className="border px-2 py-1" title={`${f.unidades} unidades`}>
                              {f.nombre}
                              {f.sinMeta > 0 && (
                                <span
                                  className="ml-1 text-[10px] text-muted-foreground"
                                  title="Unidades sin meta ese día: no se les puede sacar porcentaje"
                                >
                                  ({f.sinMeta} sin meta)
                                </span>
                              )}
                            </td>
                            {celda(f.baja, "bg-red-600 text-white")}
                            {celda(f.media, "bg-amber-400 text-black")}
                            {celda(f.alta, "bg-green-600 text-white")}
                            <td className="border px-2 py-1 text-right tabular-nums">
                              {f.gastos > 0 ? `$ ${fmt(f.gastos)}` : "$ —"}
                            </td>
                          </tr>
                        ))}
                        <tr key={`t-${pais}`} className="bg-muted font-bold">
                          <td className="border px-2 py-1">TOTAL</td>
                          {celda(sub.baja, "bg-red-600 text-white")}
                          {celda(sub.media, "bg-amber-400 text-black")}
                          {celda(sub.alta, "bg-green-600 text-white")}
                          <td className="border px-2 py-1 text-right tabular-nums">
                            {sub.gastos > 0 ? `$ ${fmt(sub.gastos)}` : "$ —"}
                          </td>
                        </tr>
                      </>
                    )
                  })}

                  <tr className="bg-slate-300 font-bold dark:bg-slate-600">
                    <td className="border px-2 py-1.5">GRAN TOTAL</td>
                    {celda(granTotal.baja, "bg-red-600 text-white")}
                    {celda(granTotal.media, "bg-amber-400 text-black")}
                    {celda(granTotal.alta, "bg-green-600 text-white")}
                    <td className="border px-2 py-1.5 text-right tabular-nums">
                      {granTotal.gastos > 0 ? `$ ${fmt(granTotal.gastos)}` : "$ —"}
                    </td>
                  </tr>
                  <tr className="bg-slate-100 font-bold dark:bg-slate-800">
                    <td className="border px-2 py-1.5" colSpan={4}>
                      TOTAL UNIDADES
                    </td>
                    <td className="border px-2 py-1.5 text-center tabular-nums">
                      {granTotal.unidades}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
