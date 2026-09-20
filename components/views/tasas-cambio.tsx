"use client"

/**
 * Tasas de cambio.
 *
 * Aquí se carga cuánta moneda local vale 1 USD, y desde qué día. La gracia no
 * es saber cuánto vale el dólar hoy —eso se busca en internet— sino que un
 * gasto del 3 de agosto se siga viendo con la tasa que había EL 3 DE AGOSTO,
 * aunque hoy el dólar esté al doble.
 *
 * Por eso cada tasa tiene un rango de vigencia y NO se edita: cargar una nueva
 * cierra la anterior el día antes (lo hace un trigger, ver scripts/119). Así
 * no quedan huecos —un día sin tasa— ni solapes —un día con dos—, que es justo
 * lo que dejaría un movimiento sin saber por cuál convertirse.
 *
 * Solo se piden tasas de las monedas que alguna ruta usa de verdad. USD no
 * lleva: un dólar vale un dólar.
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
  AlertCircle,
  ArrowRightLeft,
  Calendar,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react"
import { getSupabaseSafe } from "@/lib/api-helper"
import { todayColombia } from "@/lib/colombia-date"
import { useToast } from "@/hooks/use-toast"
import { getMoneda } from "@/lib/monedas"

interface Tasa {
  id: number
  moneda: string
  tasa: number
  vigente_desde: string
  vigente_hasta: string | null
  nota: string | null
}

/** Cómo se ve una fecha 2026-09-20 en la pantalla. */
function fFecha(iso: string | null): string {
  if (!iso) return "—"
  const [a, m, d] = iso.split("-")
  return `${d}/${m}/${a.slice(2)}`
}

/** La tasa con sus decimales, sin ceros de relleno inútiles. */
function fTasa(n: number): string {
  return Number(n).toLocaleString("es-CO", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  })
}

export function TasasCambio() {
  const { toast } = useToast()
  const hoy = todayColombia()

  const [tasas, setTasas] = useState<Tasa[]>([])
  const [monedasEnUso, setMonedasEnUso] = useState<string[]>([])
  const [cargando, setCargando] = useState(true)
  const [faltaTabla, setFaltaTabla] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [borrando, setBorrando] = useState<number | null>(null)

  // Formulario
  const [fMoneda, setFMoneda] = useState("")
  const [fTasaTxt, setFTasaTxt] = useState("")
  const [fDesde, setFDesde] = useState(hoy)
  const [fNota, setFNota] = useState("")

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const sb = await getSupabaseSafe()

      // Las monedas que alguna ruta usa de verdad. Pedir tasa del quetzal
      // cuando no hay rutas en Guatemala sería trabajo inventado.
      const rRutas = await sb.from("rutas").select("moneda")
      const enUso = [
        ...new Set(
          ((rRutas.data ?? []) as unknown as { moneda: string | null }[])
            .map((r) => (r.moneda ?? "").trim().toUpperCase())
            .filter((m) => m && m !== "USD"),
        ),
      ].sort()
      setMonedasEnUso(enUso)

      const rTasas = await sb
        .from("tasas_cambio")
        .select("id, moneda, tasa, vigente_desde, vigente_hasta, nota")
        .order("moneda")
        .order("vigente_desde", { ascending: false })

      if (rTasas.error) {
        // PostgREST devuelve PGRST205 —no 42P01— cuando la tabla no está en
        // su cache de esquema. Se comprueban las dos.
        const code = (rTasas.error as { code?: string }).code
        if (code === "PGRST205" || code === "42P01" || /tasas_cambio/i.test(rTasas.error.message)) {
          setFaltaTabla(true)
          setTasas([])
        } else {
          throw rTasas.error
        }
      } else {
        setFaltaTabla(false)
        setTasas((rTasas.data ?? []) as unknown as Tasa[])
      }
    } catch (err) {
      console.error("[v0] Tasas de cambio, carga:", err)
      toast({
        title: "Error",
        description: "No se pudieron cargar las tasas",
        variant: "destructive",
      })
    } finally {
      setCargando(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  /** La tasa que rige HOY para cada moneda, que es la que se mira primero. */
  const vigentes = useMemo(() => {
    const m = new Map<string, Tasa>()
    for (const t of tasas) {
      if (t.vigente_hasta === null && !m.has(t.moneda)) m.set(t.moneda, t)
    }
    return m
  }, [tasas])

  /** El historial agrupado por moneda. */
  const porMoneda = useMemo(() => {
    const m = new Map<string, Tasa[]>()
    for (const t of tasas) {
      const l = m.get(t.moneda)
      if (l) l.push(t)
      else m.set(t.moneda, [t])
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [tasas])

  const guardar = async () => {
    const valor = Number(fTasaTxt.replace(/\./g, "").replace(",", "."))
    if (!fMoneda) {
      toast({ title: "Falta la moneda", variant: "destructive" })
      return
    }
    if (!Number.isFinite(valor) || valor <= 0) {
      toast({
        title: "Tasa inválida",
        description: "Escribe cuánta moneda local vale 1 USD, por ejemplo 1450.",
        variant: "destructive",
      })
      return
    }

    // Cargar dos tasas de la misma moneda el mismo día rompería el rango: la
    // base lo rechaza con el UNIQUE, pero se avisa antes y con nombre propio.
    if (tasas.some((t) => t.moneda === fMoneda && t.vigente_desde === fDesde)) {
      toast({
        title: "Ya hay una tasa ese día",
        description: `El ${fFecha(fDesde)} ya tiene tasa para ${fMoneda}. Bórrala primero si quieres corregirla.`,
        variant: "destructive",
      })
      return
    }

    setGuardando(true)
    try {
      const sb = await getSupabaseSafe()
      let creadoPor: number | null = null
      try {
        const raw = localStorage.getItem("currentUser")
        if (raw) creadoPor = (JSON.parse(raw) as { id?: number }).id ?? null
      } catch {
        /* sesión ilegible: se guarda sin autor, no se pierde la tasa */
      }

      const { error } = await sb.from("tasas_cambio").insert({
        moneda: fMoneda,
        tasa: valor,
        vigente_desde: fDesde,
        nota: fNota.trim() || null,
        creado_por: creadoPor,
      })
      if (error) throw error

      toast({
        title: "Tasa registrada",
        description: `1 USD = ${fTasa(valor)} ${fMoneda} desde el ${fFecha(fDesde)}.`,
      })
      setFTasaTxt("")
      setFNota("")
      await cargar()
    } catch (err) {
      console.error("[v0] Tasas de cambio, guardar:", err)
      toast({
        title: "No se pudo guardar",
        description: err instanceof Error ? err.message : "Intenta de nuevo",
        variant: "destructive",
      })
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Borrar es para el error de dedo recién cometido.
   *
   * OJO: al borrar NO se reabre la tasa anterior —quedó cerrada el día antes—
   * así que esos días se quedan sin tasa hasta que se cargue una nueva. Se
   * avisa en el texto del botón para que no sorprenda.
   */
  const borrar = async (t: Tasa) => {
    setBorrando(t.id)
    try {
      const sb = await getSupabaseSafe()
      const { error } = await sb.from("tasas_cambio").delete().eq("id", t.id)
      if (error) throw error
      toast({ title: "Tasa eliminada" })
      await cargar()
    } catch (err) {
      console.error("[v0] Tasas de cambio, borrar:", err)
      toast({ title: "No se pudo eliminar", variant: "destructive" })
    } finally {
      setBorrando(null)
    }
  }

  if (cargando) return <Skeleton className="h-64 w-full" />

  if (faltaTabla) {
    return (
      <Card>
        <CardContent className="space-y-2 p-6 text-center">
          <AlertCircle className="mx-auto h-5 w-5 text-amber-600" />
          <p className="text-xs text-muted-foreground">
            Falta correr{" "}
            <strong>scripts/119-las-tasas-de-cambio-y-su-vigencia.sql</strong>.
            Hasta entonces no se pueden registrar tasas de cambio.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {/* ── Qué es esto ──────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex items-start gap-2 p-4">
          <ArrowRightLeft className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Cuánta moneda local vale <strong>1 dólar</strong>, y desde qué día.
            Cada tasa queda guardada con su vigencia, así un movimiento viejo se
            sigue viendo con la tasa que había <strong>en ese entonces</strong>{" "}
            y no con la de hoy. Al cargar una tasa nueva, la anterior se cierra
            sola el día antes.
          </p>
        </CardContent>
      </Card>

      {/* ── Las tasas de hoy ─────────────────────────────────────────────── */}
      {monedasEnUso.length > 0 && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {monedasEnUso.map((m) => {
            const v = vigentes.get(m)
            return (
              <Card key={m}>
                <CardContent className="p-3">
                  <p className="text-[10px] font-semibold text-muted-foreground">
                    {m} · {getMoneda(m).nombre}
                  </p>
                  {v ? (
                    <>
                      <p className="text-sm font-bold tabular-nums">
                        {fTasa(v.tasa)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        por 1 USD · desde {fFecha(v.vigente_desde)}
                      </p>
                    </>
                  ) : (
                    <p className="pt-1 text-xs font-semibold text-amber-600">
                      sin tasa
                    </p>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* ── Cargar una tasa ──────────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-xs font-semibold">Registrar una tasa</p>

          <div className="grid gap-2 md:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Moneda</Label>
              <Select value={fMoneda} onValueChange={setFMoneda}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Elige" />
                </SelectTrigger>
                <SelectContent>
                  {monedasEnUso.map((m) => (
                    <SelectItem key={m} value={m} className="text-xs">
                      {m} · {getMoneda(m).nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                Cuánto vale 1 USD
              </Label>
              <Input
                value={fTasaTxt}
                onChange={(e) => setFTasaTxt(e.target.value)}
                placeholder="1450"
                inputMode="decimal"
                className="h-9 text-xs tabular-nums"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                Rige desde
              </Label>
              <Input
                type="date"
                value={fDesde}
                onChange={(e) => setFDesde(e.target.value)}
                className="h-9 text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                Nota (opcional)
              </Label>
              <Input
                value={fNota}
                onChange={(e) => setFNota(e.target.value)}
                placeholder="Oficial BNA"
                className="h-9 text-xs"
              />
            </div>
          </div>

          {/* Se muestra la cuenta hecha: es la forma de que un cero de más se
              vea ANTES de guardar y no cuando ya está en los informes. */}
          {fMoneda && Number(fTasaTxt.replace(/\./g, "").replace(",", ".")) > 0 && (
            <p className="rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
              Con esta tasa, <strong>100.000 {fMoneda}</strong> serían{" "}
              <strong>
                USD{" "}
                {(
                  100000 / Number(fTasaTxt.replace(/\./g, "").replace(",", "."))
                ).toLocaleString("es-CO", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </strong>
              .
            </p>
          )}

          <Button
            onClick={() => void guardar()}
            disabled={guardando || !fMoneda}
            size="sm"
            className="gap-1.5"
          >
            {guardando ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Registrar tasa
          </Button>
        </CardContent>
      </Card>

      {/* ── El historial ─────────────────────────────────────────────────── */}
      {porMoneda.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-xs text-muted-foreground">
              Todavía no hay ninguna tasa registrada.
            </p>
          </CardContent>
        </Card>
      ) : (
        porMoneda.map(([moneda, lista]) => (
          <Card key={moneda}>
            <CardContent className="p-0">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <Badge variant="secondary" className="text-[10px]">
                  {moneda}
                </Badge>
                <p className="text-xs font-semibold">{getMoneda(moneda).nombre}</p>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {lista.length} {lista.length === 1 ? "tasa" : "tasas"}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[11px]">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-2 py-1.5 text-right font-semibold">
                        Por 1 USD
                      </th>
                      <th className="px-2 py-1.5 text-left font-semibold">
                        Vigencia
                      </th>
                      <th className="px-2 py-1.5 text-left font-semibold">Nota</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {lista.map((t) => (
                      <tr key={t.id} className="border-t hover:bg-muted/30">
                        <td className="px-2 py-1.5 text-right font-bold tabular-nums">
                          {fTasa(t.tasa)}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="flex items-center gap-1 whitespace-nowrap">
                            <Calendar className="h-3 w-3 shrink-0 text-muted-foreground" />
                            {fFecha(t.vigente_desde)} →{" "}
                            {t.vigente_hasta ? (
                              fFecha(t.vigente_hasta)
                            ) : (
                              <span className="font-semibold text-green-600">
                                vigente
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {t.nota || "—"}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void borrar(t)}
                            disabled={borrando === t.id}
                            title="Eliminar esta tasa. Los días que cubría quedan sin tasa hasta que cargues otra."
                            className="h-6 w-6 p-0 text-destructive"
                          >
                            {borrando === t.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}
