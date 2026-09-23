"use client"

/**
 * Resumen de todas las rutas.
 *
 * Una tarjeta por unidad con lo que un administrador quiere ver de un vistazo:
 * de qué país es, qué moto tiene, quién la cobra, cuánto debía cobrar y cuánto
 * lleva, y si abrió o cerró el día.
 *
 * LA PLATA VA EN LA MONEDA DE CADA RUTA, con su símbolo y su código delante
 * (`ARS $1.850.000`). En una lista donde conviven Argentina, Ecuador y
 * Paraguay, un `$` a secas haría creer que 1.850.000 y 850 son comparables.
 *
 * Y POR ESO NO HAY TOTAL AL PIE: sumar esta lista sería sumar pesos con
 * guaraníes. El total convertido a dólares ya está en el Dashboard.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Bike,
  ChevronRight,
  MapPin,
  RefreshCw,
  User,
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { getResumenDiaRutas } from "@/lib/resumen-dia"
import { todayColombia } from "@/lib/gestion-core"
import { Bandera } from "@/components/bandera"
import { formatearMoneda, monedaPorPais } from "@/lib/monedas"

const TODOS = "__todos"

interface FilaRuta {
  id: number
  nombre: string
  ciudad: string
  pais: string
  moneda: string
  motoPlaca: string | null
  cobrador: string | null
  debido: number
  cobrado: number
  estado: "abierta" | "cerrada" | null
}

/** "BUENOS AIRES" → "Buenos Aires". En la base conviven las dos formas. */
function capitalizar(t: string): string {
  return t
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(" ")
}

/**
 * El país de una ruta, resolviendo el caso de la 204 —que tiene `pais` y
 * `ciudad` al revés—. Misma regla de `lib/monedas.ts`.
 */
function paisYCiudad(pais: string | null, ciudad: string | null) {
  const p = (pais ?? "").trim()
  const c = (ciudad ?? "").trim()
  const pareceCiudad = /buenos aires|la plata|chaco|cuenca|quito|asunci|cali|ibarra|rioamba|cordoba|rosario/i.test(p)
  return {
    pais: capitalizar(pareceCiudad ? c : p),
    ciudad: capitalizar(pareceCiudad ? p : c),
  }
}

interface Props {
  currentUserId?: number | string | null
  onVerRuta?: (rutaId: number) => void
}

export function ResumenRutas({ currentUserId, onVerRuta }: Props) {
  const [fecha, setFecha] = useState(todayColombia)
  const [fPais, setFPais] = useState(TODOS)
  const [fEstado, setFEstado] = useState(TODOS)
  const [filas, setFilas] = useState<FilaRuta[]>([])
  const [cargando, setCargando] = useState(true)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const sb = createClient()

      // Las rutas que este usuario puede ver. Sin `currentUserId` —admin sin
      // asignaciones— se ven todas, que es el comportamiento del Dashboard.
      let rutas: { id: number; nombre: string; ciudad: string | null; pais: string | null; moneda: string | null }[] = []
      if (currentUserId) {
        const { data } = await sb
          .from("usuario_rutas")
          .select("rutas:ruta_id(id, nombre, ciudad, pais, moneda)")
          .eq("usuario_id", currentUserId)
        rutas = ((data ?? []) as unknown as { rutas: typeof rutas[number] }[])
          .map((r) => r.rutas)
          .filter(Boolean)
      }
      if (rutas.length === 0) {
        const { data } = await sb
          .from("rutas")
          .select("id, nombre, ciudad, pais, moneda")
          .order("id")
        rutas = (data ?? []) as unknown as typeof rutas
      }
      const ids = rutas.map((r) => r.id)
      if (ids.length === 0) {
        setFilas([])
        return
      }

      // Todo lo demás en paralelo: nada depende de nada.
      const [porRuta, resConfig, resEstados, resAsign, resUsuarios] = await Promise.all([
        getResumenDiaRutas(sb, ids, fecha),
        // La moto vive en la config de la unidad (scripts/120). Si el script
        // no se corrió, la consulta falla y se sigue sin moto.
        sb.from("ruta_config_umbrales").select("ruta_id, moto_placa").in("ruta_id", ids),
        sb.from("rutas_diarias").select("ruta_id, estado").eq("fecha", fecha).in("ruta_id", ids),
        sb.from("usuario_rutas").select("ruta_id, usuario_id").in("ruta_id", ids),
        sb.from("usuarios").select("id, nombre, rol"),
      ])

      const motos = new Map<number, string | null>()
      if (!resConfig.error) {
        for (const c of (resConfig.data ?? []) as unknown as { ruta_id: number; moto_placa: string | null }[]) {
          motos.set(c.ruta_id, c.moto_placa)
        }
      }

      const estados = new Map<number, "abierta" | "cerrada">()
      for (const e of (resEstados.data ?? []) as unknown as { ruta_id: number; estado: string }[]) {
        if (e.estado === "abierta" || e.estado === "cerrada") estados.set(e.ruta_id, e.estado)
      }

      // EL COBRADOR de cada ruta: el usuario con rol vendedor que la tenga
      // asignada. No hay rol "tarjetero" ni "supervisor" en este sistema, así
      // que no se inventan chips que no corresponden a nadie.
      const us = new Map(
        ((resUsuarios.data ?? []) as unknown as { id: number; nombre: string | null; rol: string | null }[])
          .map((u) => [u.id, u]),
      )
      const cobradores = new Map<number, string>()
      for (const a of (resAsign.data ?? []) as unknown as { ruta_id: number; usuario_id: number }[]) {
        const u = us.get(a.usuario_id)
        if ((u?.rol ?? "").toLowerCase() !== "vendedor") continue
        if (!cobradores.has(a.ruta_id)) cobradores.set(a.ruta_id, u?.nombre ?? `#${a.usuario_id}`)
      }

      const n = (v: unknown) => Number(v) || 0
      setFilas(
        rutas
          .map((r) => {
            const f = porRuta.get(r.id)?.fila as Record<string, unknown> | undefined
            const { pais, ciudad } = paisYCiudad(r.pais, r.ciudad)
            return {
              id: r.id,
              nombre: r.nombre,
              ciudad,
              pais,
              // Si la ruta no tiene moneda guardada se deduce del país, en vez
              // de mostrar la plata sin decir de qué moneda es.
              moneda: (r.moneda ?? "").trim().toUpperCase()
                || monedaPorPais(r.pais, r.ciudad)
                || "",
              motoPlaca: motos.get(r.id) ?? null,
              cobrador: cobradores.get(r.id) ?? null,
              debido: n(f?.meta_pagos),
              cobrado: n(f?.valor_pago),
              estado: estados.get(r.id) ?? null,
            }
          })
          .sort((a, b) => a.pais.localeCompare(b.pais) || a.id - b.id),
      )
    } catch (err) {
      console.error("[v0] Resumen de rutas:", err)
      setFilas([])
    } finally {
      setCargando(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fecha, currentUserId])

  useEffect(() => {
    void cargar()
  }, [cargar])

  const paises = useMemo(
    () => [...new Set(filas.map((f) => f.pais).filter(Boolean))].sort(),
    [filas],
  )

  const visibles = useMemo(
    () =>
      filas.filter((f) => {
        if (fPais !== TODOS && f.pais !== fPais) return false
        if (fEstado === "abierta" && f.estado !== "abierta") return false
        if (fEstado === "cerrada" && f.estado !== "cerrada") return false
        if (fEstado === "sin" && f.estado !== null) return false
        return true
      }),
    [filas, fPais, fEstado],
  )

  return (
    <div className="space-y-2">
      {/* ── Filtros ───────────────────────────────────────────────────────── */}
      <Card className="border-0 bg-card shadow-sm">
        <CardContent className="flex flex-wrap items-end gap-2 px-3 py-2">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Fecha</Label>
            <Input
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              className="h-8 w-[140px] text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">País</Label>
            <Select value={fPais} onValueChange={setFPais}>
              <SelectTrigger className="h-8 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS} className="text-xs">Todos</SelectItem>
                {paises.map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Estado</Label>
            <Select value={fEstado} onValueChange={setFEstado}>
              <SelectTrigger className="h-8 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS} className="text-xs">Todas</SelectItem>
                <SelectItem value="abierta" className="text-xs">Abiertas</SelectItem>
                <SelectItem value="cerrada" className="text-xs">Cerradas</SelectItem>
                <SelectItem value="sin" className="text-xs">Sin iniciar</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void cargar()}
            className="h-8 gap-1.5 text-xs"
          >
            <RefreshCw className="h-3 w-3" />
            Actualizar
          </Button>
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {visibles.length} de {filas.length}
          </Badge>
        </CardContent>
      </Card>

      {cargando ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : visibles.length === 0 ? (
        <Card className="border-0 bg-card shadow-sm">
          <CardContent className="p-6 text-center">
            <p className="text-xs text-muted-foreground">
              No hay unidades con esos filtros.
            </p>
          </CardContent>
        </Card>
      ) : (
        visibles.map((f) => {
          const pct = f.debido > 0 ? Math.round((f.cobrado / f.debido) * 100) : null
          const tono =
            pct === null ? "bg-muted-foreground"
              : pct >= 90 ? "bg-success"
                : pct >= 50 ? "bg-warning"
                  : "bg-destructive"
          return (
            <Card key={f.id} className="border-0 bg-card shadow-sm">
              <CardContent className="px-3 py-2">
                {/* Identidad: bandera, nombre, país y ciudad */}
                <div className="flex items-start gap-2">
                  <Bandera moneda={f.moneda} pais={f.pais} size={38} className="mt-0.5 shadow-sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold leading-tight text-foreground">
                      {f.nombre}
                    </p>
                    <p className="truncate text-[11px] leading-tight text-muted-foreground">
                      {f.pais}
                      {f.ciudad ? ` · ${f.ciudad}` : ""}
                    </p>
                  </div>
                  {/* El estado del día. "Sin iniciar" no es un error: es que
                      todavía no arrancó, y se distingue de "cerrada". */}
                  <Badge
                    className={`shrink-0 gap-1 border-0 text-[10px] ${
                      f.estado === "abierta"
                        ? "bg-success-light text-success"
                        : f.estado === "cerrada"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        f.estado === "abierta" ? "bg-success"
                          : f.estado === "cerrada" ? "bg-destructive"
                            : "bg-muted-foreground"
                      }`}
                    />
                    {f.estado === "abierta" ? "Abierta"
                      : f.estado === "cerrada" ? "Cerrada"
                        : "Sin iniciar"}
                  </Badge>
                </div>

                {/* Moto y cobrador. Solo lo que existe de verdad: este sistema
                    no tiene rol de tarjetero ni de supervisor. */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    <Bike className="h-3 w-3 shrink-0" />
                    {f.motoPlaca ?? "Sin moto"}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    <User className="h-3 w-3 shrink-0" />
                    <span className="max-w-[130px] truncate">
                      {f.cobrador ?? "Sin cobrador"}
                    </span>
                  </span>
                </div>

                {/* La plata, SIEMPRE con su moneda delante */}
                <div className="mt-1.5 grid grid-cols-2 gap-2 border-t pt-1.5">
                  <div className="min-w-0">
                    <p className="text-[10px] leading-tight text-muted-foreground">
                      Debido cobrar
                    </p>
                    <p className="truncate text-sm font-bold leading-tight tabular-nums text-foreground">
                      {f.moneda} {formatearMoneda(f.debido, f.moneda)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] leading-tight text-muted-foreground">
                      Cobrado
                    </p>
                    <p className="truncate text-sm font-bold leading-tight tabular-nums text-success">
                      {f.moneda} {formatearMoneda(f.cobrado, f.moneda)}
                    </p>
                  </div>
                </div>

                <div className="mt-1 flex items-center gap-1.5">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${tono}`}
                      style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-[10px] font-bold tabular-nums text-muted-foreground">
                    {pct === null ? "sin meta" : `${pct}%`}
                  </span>
                  {onVerRuta && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onVerRuta(f.id)}
                      className="h-6 shrink-0 gap-0.5 px-1.5 text-[10px] text-brand"
                    >
                      Ver ruta
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })
      )}

      {/* NO hay total al pie, y es a proposito: sumar esta lista seria sumar
          pesos con guaranies. El total convertido vive en el Dashboard. */}
      {visibles.length > 0 && (
        <p className="px-1 pb-1 text-center text-[10px] text-muted-foreground">
          <MapPin className="mr-0.5 inline h-3 w-3" />
          Cada unidad en su moneda — no se suman entre sí.
        </p>
      )}
    </div>
  )
}
