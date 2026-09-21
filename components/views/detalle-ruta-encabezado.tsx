"use client"

/**
 * El encabezado del Detalle de Ruta.
 *
 * Quién es la unidad —país, ciudad, moto, cobrador—, cuánto debía cobrar y
 * cuánto lleva, y los seis contadores del día. Va encima del detalle de
 * movimientos que ya existía, que es el que responde "y qué pasó exactamente".
 *
 * LA PLATA VA EN LA MONEDA DE LA RUTA. El título dice "Resumen de la ruta
 * (ARS)" a propósito: en un sistema con cuatro países, un `$` sin apellido no
 * dice de qué moneda se habla.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ArrowDownCircle,
  Bike,
  CheckCircle,
  MapPin,
  Receipt,
  ShoppingCart,
  TrendingUp,
  User,
  Users,
  XCircle,
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { getResumenDia } from "@/lib/resumen-dia"
import { Bandera } from "@/components/bandera"
import { formatearMoneda, monedaPorPais } from "@/lib/monedas"

interface Props {
  rutaId: number
  fecha: string
}

interface Datos {
  nombre: string
  pais: string
  ciudad: string
  moneda: string
  motoPlaca: string | null
  motoFoto: string | null
  cobrador: string | null
  clientes: number
  estado: "abierta" | "cerrada" | null
  debido: number
  cobrado: number
  pagos: number
  noPagos: number
  ventas: number
  gastos: number
  ingresos: number
  retiros: number
}

function capitalizar(t: string): string {
  return t
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(" ")
}

/** Resuelve el caso de la 204, que tiene `pais` y `ciudad` al revés. */
function paisYCiudad(pais: string | null, ciudad: string | null) {
  const p = (pais ?? "").trim()
  const c = (ciudad ?? "").trim()
  const pareceCiudad = /buenos aires|la plata|chaco|cuenca|quito|asunci|cali|ibarra|rioamba|cordoba|rosario/i.test(p)
  return {
    pais: capitalizar(pareceCiudad ? c : p),
    ciudad: capitalizar(pareceCiudad ? p : c),
  }
}

export function DetalleRutaEncabezado({ rutaId, fecha }: Props) {
  const [d, setD] = useState<Datos | null>(null)
  const [cargando, setCargando] = useState(true)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const sb = createClient()

      const [resRuta, resResumen, resConfig, resEstado, resAsign, resUsuarios, resClientes] =
        await Promise.all([
          sb.from("rutas").select("id, nombre, ciudad, pais, moneda").eq("id", rutaId).maybeSingle(),
          getResumenDia(sb, rutaId, fecha),
          // La moto sale de scripts/120. Si no se corrió, se sigue sin ella.
          sb.from("ruta_config_umbrales").select("moto_placa, moto_foto_url").eq("ruta_id", rutaId).maybeSingle(),
          sb.from("rutas_diarias").select("estado").eq("ruta_id", rutaId).eq("fecha", fecha).maybeSingle(),
          sb.from("usuario_rutas").select("usuario_id").eq("ruta_id", rutaId),
          sb.from("usuarios").select("id, nombre, rol"),
          // `head` + count: se necesita el NÚMERO de clientes, no la lista.
          // Traerlos todos para contarlos son cientos de filas por gusto.
          sb.from("clients").select("id", { count: "exact", head: true }).eq("ruta", rutaId),
        ])

      const r = resRuta.data as { nombre?: string; ciudad?: string | null; pais?: string | null; moneda?: string | null } | null
      const { pais, ciudad } = paisYCiudad(r?.pais ?? null, r?.ciudad ?? null)

      const cfg = resConfig.error
        ? null
        : (resConfig.data as { moto_placa?: string | null; moto_foto_url?: string | null } | null)

      // El cobrador: el usuario con rol vendedor asignado a esta ruta.
      const us = new Map(
        ((resUsuarios.data ?? []) as unknown as { id: number; nombre: string | null; rol: string | null }[])
          .map((u) => [u.id, u]),
      )
      let cobrador: string | null = null
      for (const a of (resAsign.data ?? []) as unknown as { usuario_id: number }[]) {
        const u = us.get(a.usuario_id)
        if ((u?.rol ?? "").toLowerCase() === "vendedor") {
          cobrador = u?.nombre ?? null
          break
        }
      }

      const f = (resResumen.fila ?? {}) as unknown as Record<string, unknown>
      const n = (v: unknown) => Number(v) || 0
      const est = (resEstado.data as { estado?: string } | null)?.estado

      setD({
        nombre: r?.nombre ?? `Ruta ${rutaId}`,
        pais,
        ciudad,
        moneda: (r?.moneda ?? "").trim().toUpperCase() || monedaPorPais(r?.pais, r?.ciudad) || "",
        motoPlaca: cfg?.moto_placa ?? null,
        motoFoto: cfg?.moto_foto_url ?? null,
        cobrador,
        clientes: resClientes.count ?? 0,
        estado: est === "abierta" || est === "cerrada" ? est : null,
        debido: n(f.meta_pagos),
        cobrado: n(f.valor_pago),
        pagos: n(f.cantidad_pagos),
        noPagos: n(f.cantidad_no_pagos),
        ventas: n(f.cantidad_ventas),
        gastos: n(f.cantidad_gastos),
        ingresos: n(f.cantidad_ingresos),
        retiros: n(f.cantidad_retiros),
      })
    } catch (err) {
      console.error("[v0] Encabezado del detalle de ruta:", err)
      setD(null)
    } finally {
      setCargando(false)
    }
  }, [rutaId, fecha])

  useEffect(() => {
    void cargar()
  }, [cargar])

  if (cargando) return <Skeleton className="h-56 w-full" />
  if (!d) return null

  const pct = d.debido > 0 ? Math.round((d.cobrado / d.debido) * 100) : null
  const tono =
    pct === null ? "bg-muted-foreground"
      : pct >= 90 ? "bg-success"
        : pct >= 50 ? "bg-warning"
          : "bg-destructive"

  const contadores = [
    { label: "Pagos", valor: d.pagos, icono: CheckCircle, tono: "text-success" },
    { label: "No pagos", valor: d.noPagos, icono: XCircle, tono: "text-destructive" },
    { label: "Ventas", valor: d.ventas, icono: ShoppingCart, tono: "text-info" },
    { label: "Gastos", valor: d.gastos, icono: Receipt, tono: "text-destructive" },
    { label: "Ingresos", valor: d.ingresos, icono: TrendingUp, tono: "text-success" },
    { label: "Retiros", valor: d.retiros, icono: ArrowDownCircle, tono: "text-icon-withdrawal" },
  ]

  return (
    <div className="space-y-2">
      {/* ── Identidad de la unidad ────────────────────────────────────────── */}
      <Card className="border-0 bg-card shadow-sm">
        <CardContent className="px-3 py-2.5">
          <div className="flex items-start gap-2.5">
            {/* La foto de la moto si la hay; si no, la bandera. Es la imagen
                que identifica la unidad de un vistazo. */}
            {d.motoFoto ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={d.motoFoto}
                alt={`Moto de ${d.nombre}`}
                className="h-16 w-20 shrink-0 rounded-lg border object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none" }}
              />
            ) : (
              <div className="grid h-16 w-20 shrink-0 place-items-center rounded-lg border bg-muted/40">
                <Bike className="h-7 w-7 text-muted-foreground" />
              </div>
            )}

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-base font-bold leading-tight text-foreground">
                  {d.nombre}
                </p>
                <Badge
                  className={`shrink-0 gap-1 border-0 text-[10px] ${
                    d.estado === "abierta" ? "bg-success-light text-success"
                      : d.estado === "cerrada" ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${
                    d.estado === "abierta" ? "bg-success"
                      : d.estado === "cerrada" ? "bg-destructive" : "bg-muted-foreground"
                  }`} />
                  {d.estado === "abierta" ? "Abierta" : d.estado === "cerrada" ? "Cerrada" : "Sin iniciar"}
                </Badge>
              </div>

              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <Bandera moneda={d.moneda} size={16} />
                <span className="truncate font-semibold text-foreground">{d.pais}</span>
                {d.ciudad && <span className="truncate">· {d.ciudad}</span>}
              </p>

              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Users className="h-3 w-3 shrink-0" />
                {d.clientes} {d.clientes === 1 ? "cliente asignado" : "clientes asignados"}
              </p>
            </div>
          </div>

          {/* Moto y cobrador. Solo lo que existe: este sistema no tiene rol
              de tarjetero ni de supervisor. */}
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <div className="rounded-lg border bg-muted/20 px-2 py-1.5">
              <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Bike className="h-3 w-3 shrink-0" />
                Unidad / Moto
              </p>
              <p className="truncate text-xs font-bold text-foreground">
                {d.motoPlaca ?? "Sin registrar"}
              </p>
            </div>
            <div className="rounded-lg border bg-muted/20 px-2 py-1.5">
              <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <User className="h-3 w-3 shrink-0" />
                Cobrador
              </p>
              <p className="truncate text-xs font-bold text-foreground">
                {d.cobrador ?? "Sin asignar"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Resumen de la ruta ────────────────────────────────────────────── */}
      <Card className="border-0 bg-card shadow-sm">
        <CardContent className="px-3 py-2">
          {/* La moneda en el TITULO: "Resumen de la ruta (ARS)". Sin eso, un
              `$` a secas no dice de que moneda se habla. */}
          <p className="mb-1.5 text-xs font-bold text-foreground">
            Resumen de la ruta{d.moneda ? ` (${d.moneda})` : ""}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0">
              <p className="text-[10px] leading-tight text-muted-foreground">Debido cobrar</p>
              <p className="truncate text-base font-bold leading-tight tabular-nums text-foreground">
                {formatearMoneda(d.debido, d.moneda)}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] leading-tight text-muted-foreground">Cobrado</p>
              <p className="truncate text-base font-bold leading-tight tabular-nums text-success">
                {formatearMoneda(d.cobrado, d.moneda)}
              </p>
            </div>
          </div>

          <div className="mt-1.5 flex items-center gap-2">
            <span className="shrink-0 text-[10px] text-muted-foreground">Avance</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div className={`h-full rounded-full ${tono}`} style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
            </div>
            <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">
              {pct === null ? "sin meta" : `${pct}%`}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Los seis contadores del día ───────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-1.5">
        {contadores.map((c) => (
          <Card key={c.label} className="border-0 bg-card shadow-sm">
            <CardContent className="px-2 py-1.5 text-center">
              <c.icono className={`mx-auto h-4 w-4 ${c.tono}`} />
              <p className="text-[10px] leading-tight text-muted-foreground">{c.label}</p>
              <p className={`text-base font-bold leading-tight tabular-nums ${c.tono}`}>
                {c.valor}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="px-1 text-center text-[10px] text-muted-foreground">
        <MapPin className="mr-0.5 inline h-3 w-3" />
        Movimientos del {fecha.split("-").reverse().join("/")} — el detalle va abajo.
      </p>
    </div>
  )
}
