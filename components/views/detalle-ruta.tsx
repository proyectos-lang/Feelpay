"use client"

/**
 * Detalle de Ruta.
 *
 * Reemplaza por completo la pantalla anterior, que era una tabla de
 * movimientos con seis pestañas. Esta responde otra pregunta: QUIÉN es esta
 * unidad y CÓMO le está yendo hoy.
 *
 * El orden es el del diseño: identidad arriba (moto, país, clientes, horario),
 * la gente a cargo, el resumen de plata con el avance, los seis contadores del
 * día, y abajo las pestañas con el detalle.
 *
 * LA PLATA VA EN LA MONEDA DE LA RUTA, y el título lo dice —"Resumen de la
 * ruta (ARS)"—: con cuatro países, un `$` sin apellido no dice de qué moneda
 * se habla.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ArrowDownCircle,
  Bike,
  CheckCircle2,
  Clock,
  CreditCard,
  MapPin,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  User,
  Users,
  XCircle,
} from "lucide-react"
import dynamic from "next/dynamic"
import { createClient } from "@/lib/supabase/client"
import type { MapPoint } from "./admin-route-monitor-map"

/** El mismo mapa del Monitoreo de Rutas, que ya dibuja el recorrido en orden. */
const MapaRuta = dynamic(() => import("./admin-route-monitor-map"), {
  ssr: false,
  loading: () => (
    <div className="grid h-[300px] w-full place-items-center bg-muted/30">
      <span className="text-xs text-muted-foreground">Cargando mapa…</span>
    </div>
  ),
})
import { getResumenDia } from "@/lib/resumen-dia"
import {
  todayColombia,
  horaColombia,
  fmtMoneda,
  montoEfectivo,
} from "@/lib/gestion-core"
import { Bandera } from "@/components/bandera"
import { formatearMoneda, monedaPorPais } from "@/lib/monedas"

type Pestana = "clientes" | "mapa" | "movimientos"

interface Props {
  currentUserId?: number | string | null
  /** Ruta con la que abrir, cuando se llega desde el Resumen de Rutas. */
  rutaInicial?: number | null
}

interface RutaInfo {
  id: number
  nombre: string
  ciudad: string | null
  pais: string | null
  moneda: string | null
}

interface ClienteDia {
  loanId: string
  nombre: string
  direccion: string
  zona: string
  cuota: number
  estado: "pago" | "no_pago" | "pendiente"
}

interface MovimientoRow {
  id: string
  hora: string
  cliente: string
  tipo: string
  monto: number
}

interface GastoRow {
  id: number
  hora: string
  tipo: string
  concepto: string
  valor: number
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
  const pareceCiudad =
    /buenos aires|la plata|chaco|cuenca|quito|asunci|cali|ibarra|rioamba|cordoba|rosario/i.test(p)
  return {
    pais: capitalizar(pareceCiudad ? c : p),
    ciudad: capitalizar(pareceCiudad ? p : c),
  }
}

export function DetalleRuta({ currentUserId, rutaInicial }: Props) {
  const [fecha, setFecha] = useState(todayColombia)
  const [rutaId, setRutaId] = useState<number | null>(rutaInicial ?? null)
  const [rutas, setRutas] = useState<RutaInfo[]>([])
  const [pestana, setPestana] = useState<Pestana>("clientes")
  const [busqueda, setBusqueda] = useState("")
  const [cargando, setCargando] = useState(true)

  // Datos de la unidad
  const [moneda, setMoneda] = useState("")
  const [pais, setPais] = useState("")
  const [ciudad, setCiudad] = useState("")
  const [nombre, setNombre] = useState("")
  const [motoPlaca, setMotoPlaca] = useState<string | null>(null)
  const [motoFoto, setMotoFoto] = useState<string | null>(null)
  const [cobrador, setCobrador] = useState<string | null>(null)
  const [clientes, setClientes] = useState(0)
  const [estado, setEstado] = useState<"abierta" | "cerrada" | null>(null)
  const [horaInicio, setHoraInicio] = useState<string | null>(null)
  const [horaFin, setHoraFin] = useState<string | null>(null)

  // Plata y contadores
  const [debido, setDebido] = useState(0)
  const [cobrado, setCobrado] = useState(0)
  const [cont, setCont] = useState({ pagos: 0, noPagos: 0, ventas: 0, gastos: 0, ingresos: 0, retiros: 0 })

  // Las tres listas
  const [clientesDia, setClientesDia] = useState<ClienteDia[]>([])
  const [movimientos, setMovimientos] = useState<MovimientoRow[]>([])
  const [gastos, setGastos] = useState<GastoRow[]>([])
  /** Los puntos del recorrido: donde se registro cada gestion del dia. */
  const [puntos, setPuntos] = useState<MapPoint[]>([])

  // ── Las rutas que este usuario puede ver ───────────────────────────────────
  useEffect(() => {
    const cargar = async () => {
      const sb = createClient()
      let lista: RutaInfo[] = []
      if (currentUserId) {
        const { data } = await sb
          .from("usuario_rutas")
          .select("rutas:ruta_id(id, nombre, ciudad, pais, moneda)")
          .eq("usuario_id", currentUserId)
        lista = ((data ?? []) as unknown as { rutas: RutaInfo }[])
          .map((r) => r.rutas)
          .filter(Boolean)
      }
      if (lista.length === 0) {
        const { data } = await sb
          .from("rutas")
          .select("id, nombre, ciudad, pais, moneda")
          .order("id")
        lista = (data ?? []) as unknown as RutaInfo[]
      }
      lista.sort((a, b) => a.id - b.id)
      setRutas(lista)
      // Sin ruta elegida se abre con la primera: esta pantalla es de UNA
      // unidad, así que no tiene un estado "todas" que mostrar.
      setRutaId((prev) => prev ?? lista[0]?.id ?? null)
    }
    void cargar()
  }, [currentUserId])

  // ── Todo lo de la unidad y el día ──────────────────────────────────────────
  const cargar = useCallback(async () => {
    if (rutaId == null) return
    setCargando(true)
    try {
      const sb = createClient()

      const [resRuta, resResumen, resCfg, resDia, resAsign, resUsuarios, resClientes] =
        await Promise.all([
          sb.from("rutas").select("id, nombre, ciudad, pais, moneda").eq("id", rutaId).maybeSingle(),
          getResumenDia(sb, rutaId, fecha),
          sb.from("ruta_config_umbrales").select("moto_placa, moto_foto_url").eq("ruta_id", rutaId).maybeSingle(),
          sb.from("rutas_diarias").select("estado, hora_inicio, hora_fin").eq("ruta_id", rutaId).eq("fecha", fecha).maybeSingle(),
          sb.from("usuario_rutas").select("usuario_id").eq("ruta_id", rutaId),
          sb.from("usuarios").select("id, nombre, rol"),
          sb.from("clients").select("id", { count: "exact", head: true }).eq("ruta", rutaId),
        ])

      const r = resRuta.data as RutaInfo | null
      const pc = paisYCiudad(r?.pais ?? null, r?.ciudad ?? null)
      setNombre(r?.nombre ?? `Ruta ${rutaId}`)
      setPais(pc.pais)
      setCiudad(pc.ciudad)
      setMoneda((r?.moneda ?? "").trim().toUpperCase() || monedaPorPais(r?.pais, r?.ciudad) || "")

      // La moto sale de scripts/120; si no se corrió, se sigue sin ella.
      const cfg = resCfg.error ? null : (resCfg.data as { moto_placa?: string | null; moto_foto_url?: string | null } | null)
      setMotoPlaca(cfg?.moto_placa ?? null)
      setMotoFoto(cfg?.moto_foto_url ?? null)

      const dia = resDia.data as { estado?: string; hora_inicio?: string | null; hora_fin?: string | null } | null
      setEstado(dia?.estado === "abierta" || dia?.estado === "cerrada" ? dia.estado : null)
      setHoraInicio(dia?.hora_inicio ?? null)
      setHoraFin(dia?.hora_fin ?? null)
      setClientes(resClientes.count ?? 0)

      // El COBRADOR: el usuario con rol vendedor asignado a esta ruta.
      const us = new Map(
        ((resUsuarios.data ?? []) as unknown as { id: number; nombre: string | null; rol: string | null }[])
          .map((u) => [u.id, u]),
      )
      let cob: string | null = null
      for (const a of (resAsign.data ?? []) as unknown as { usuario_id: number }[]) {
        const u = us.get(a.usuario_id)
        if ((u?.rol ?? "").toLowerCase() === "vendedor") { cob = u?.nombre ?? null; break }
      }
      setCobrador(cob)

      const f = (resResumen.fila ?? {}) as unknown as Record<string, unknown>
      const n = (v: unknown) => Number(v) || 0
      setDebido(n(f.meta_pagos))
      setCobrado(n(f.valor_pago))
      setCont({
        pagos: n(f.cantidad_pagos),
        noPagos: n(f.cantidad_no_pagos),
        ventas: n(f.cantidad_ventas),
        gastos: n(f.cantidad_gastos),
        ingresos: n(f.cantidad_ingresos),
        retiros: n(f.cantidad_retiros),
      })

      // ── Las tres listas de abajo ────────────────────────────────────────
      const dayStart = `${fecha}T00:00:00-05:00`
      const dayEnd = `${fecha}T23:59:59-05:00`
      const [resPlan, resGest, resGastos] = await Promise.all([
        // CLIENTES: sale del CRONOGRAMA, no de los pagos. La pregunta es "a
        // quién había que cobrarle", así que los que NO pagaron tienen que
        // aparecer — son justo los que interesan.
        sb.from("payment_plan")
          .select("loan_id, valor_cuota, loans!inner(ruta, estado, clients(nombre_completo, direccion, sector))")
          .eq("fecha_pago", fecha)
          .eq("loans.ruta", rutaId)
          .neq("loans.estado", "anulado"),
        sb.from("gestiones")
          .select("id, loan_id, tipo, monto, fecha_hora, latitud, longitud, loans:loans(clients:clients(nombre_completo))")
          .eq("ruta", rutaId)
          .eq("fecha_gestion", fecha)
          .eq("estado", "aplicada")
          .neq("origen", "homologacion")
          .order("fecha_hora", { ascending: true }),
        sb.from("gastosregistros")
          .select("id, tipo, concepto, valor, fechahorasol")
          .eq("ruta", rutaId)
          .gte("fechahorasol", dayStart)
          .lte("fechahorasol", dayEnd)
          .in("tipo", ["Gasto", "Ingreso", "Retiro"])
          .order("fechahorasol", { ascending: true }),
      ])

      const pagado = new Map<string, number>()
      const visitado = new Set<string>()
      const movs: MovimientoRow[] = []
      const pts: MapPoint[] = []
      for (const g of (resGest.data ?? []) as unknown as {
        id: string; loan_id: string; tipo: string; monto: number | null; fecha_hora: string
        latitud: number | null; longitud: number | null
        loans?: { clients?: { nombre_completo?: string | null } | null } | null
      }[]) {
        const m = montoEfectivo(g as never)
        if (g.loan_id) {
          visitado.add(g.loan_id)
          if (m !== 0) pagado.set(g.loan_id, (pagado.get(g.loan_id) ?? 0) + m)
        }
        movs.push({
          id: g.id,
          hora: horaColombia(g.fecha_hora) || "—",
          cliente: g.loans?.clients?.nombre_completo ?? "—",
          tipo: g.tipo,
          monto: m,
        })

        // EL RECORRIDO SALE DE DONDE SE REGISTRO CADA GESTION, no de la
        // direccion del cliente: es por donde paso el cobrador de verdad. Una
        // gestion sin coordenadas —capturada sin GPS— simplemente no pinta
        // punto, en vez de inventarle una.
        if (g.latitud != null && g.longitud != null) {
          pts.push({
            id: g.id,
            lat: Number(g.latitud),
            lng: Number(g.longitud),
            estado: m > 0 ? "pagado" : "no_pago",
            cliente: g.loans?.clients?.nombre_completo ?? "—",
            monto: m,
            hora: horaColombia(g.fecha_hora) || "—",
            orden: pts.length + 1,
          })
        }
      }
      setMovimientos(movs)
      setPuntos(pts)

      setClientesDia(
        ((resPlan.data ?? []) as unknown as {
          loan_id: string; valor_cuota: number | null
          loans?: { clients?: { nombre_completo?: string | null; direccion?: string | null; sector?: string | null } | null } | null
        }[])
          .map((p) => ({
            loanId: p.loan_id,
            nombre: p.loans?.clients?.nombre_completo ?? "—",
            direccion: p.loans?.clients?.direccion ?? "",
            zona: p.loans?.clients?.sector ?? "",
            cuota: Number(p.valor_cuota) || 0,
            estado: (pagado.get(p.loan_id) ?? 0) > 0
              ? ("pago" as const)
              : visitado.has(p.loan_id) ? ("no_pago" as const) : ("pendiente" as const),
          }))
          .sort((a, b) => a.nombre.localeCompare(b.nombre)),
      )

      setGastos(
        ((resGastos.data ?? []) as unknown as {
          id: number; tipo: string; concepto: string; valor: number; fechahorasol: string
        }[]).map((g) => ({
          id: g.id,
          hora: horaColombia(g.fechahorasol) || "—",
          tipo: g.tipo,
          concepto: g.concepto,
          valor: Number(g.valor) || 0,
        })),
      )
    } catch (err) {
      console.error("[v0] Detalle de ruta:", err)
    } finally {
      setCargando(false)
    }
  }, [rutaId, fecha])

  useEffect(() => { void cargar() }, [cargar])

  const pct = debido > 0 ? Math.round((cobrado / debido) * 100) : null
  const tono =
    pct === null ? "bg-muted-foreground"
      : pct >= 90 ? "bg-success"
        : pct >= 50 ? "bg-warning"
          : "bg-destructive"

  /** El buscador filtra la lista que se esté mirando. */
  const q = busqueda.trim().toLowerCase()
  const clientesFiltrados = useMemo(
    () => (q ? clientesDia.filter((c) =>
      c.nombre.toLowerCase().includes(q) || c.direccion.toLowerCase().includes(q) || c.zona.toLowerCase().includes(q),
    ) : clientesDia),
    [clientesDia, q],
  )
  const movsFiltrados = useMemo(
    () => (q ? movimientos.filter((m) => m.cliente.toLowerCase().includes(q)) : movimientos),
    [movimientos, q],
  )
  const gastosFiltrados = useMemo(
    () => (q ? gastos.filter((g) => g.concepto.toLowerCase().includes(q) || g.tipo.toLowerCase().includes(q)) : gastos),
    [gastos, q],
  )

  const contadores = [
    { label: "Pagos", valor: cont.pagos, icono: CheckCircle2, color: "text-success" },
    { label: "No pagos", valor: cont.noPagos, icono: XCircle, color: "text-destructive" },
    { label: "Ventas", valor: cont.ventas, icono: ShoppingCart, color: "text-info" },
    { label: "Gastos", valor: cont.gastos, icono: Receipt, color: "text-destructive" },
    { label: "Ingresos", valor: cont.ingresos, icono: TrendingUp, color: "text-success" },
    { label: "Retiros", valor: cont.retiros, icono: ArrowDownCircle, color: "text-icon-withdrawal" },
  ]

  const pestanas: { id: Pestana; label: string; icono: React.ElementType; n: number }[] = [
    { id: "clientes", label: "Clientes", icono: Users, n: clientesDia.length },
    { id: "mapa", label: "Mapa", icono: MapPin, n: puntos.length },
    { id: "movimientos", label: "Movimientos", icono: CreditCard, n: movimientos.length + gastos.length },
  ]

  return (
    <div className="space-y-1">
      {/* ── Fecha, ruta y buscador ─────────────────────────────────────────── */}
      <Card className="border-0 bg-card shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-1 p-1.5">
          <Input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className="h-7 w-[124px] text-xs"
          />
          <Select value={rutaId != null ? String(rutaId) : ""} onValueChange={(v) => setRutaId(Number(v))}>
            <SelectTrigger className="h-7 w-[128px] text-xs">
              <SelectValue placeholder="Unidad" />
            </SelectTrigger>
            <SelectContent>
              {rutas.map((r) => (
                <SelectItem key={r.id} value={String(r.id)} className="text-xs">
                  {r.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative min-w-[150px] flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar cliente…"
              className="h-7 pl-7 text-xs"
            />
          </div>
          <Button size="icon" variant="outline" onClick={() => void cargar()} className="h-7 w-7 shrink-0">
            <RefreshCw className={`h-3.5 w-3.5 ${cargando ? "animate-spin" : ""}`} />
          </Button>
        </CardContent>
      </Card>

      {cargando ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {/* ── Identidad de la unidad ───────────────────────────────────── */}
          <Card className="border-0 bg-card shadow-sm">
            <CardContent className="px-3 py-2">
              {/* En pantalla ancha va TODO en una fila —moto, identidad,
                  clientes y jornada— como el diseño. En telefono se apila,
                  que es lo unico que cabe en 390px. */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex flex-1 items-center gap-2">
                {motoFoto ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={motoFoto}
                    alt={`Moto de ${nombre}`}
                    className="h-12 w-14 shrink-0 rounded-md border object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none" }}
                  />
                ) : (
                  <div className="grid h-12 w-14 shrink-0 place-items-center rounded-md border bg-muted/40">
                    <Bike className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-base font-bold leading-tight text-foreground">{nombre}</p>
                    <Badge className={`shrink-0 gap-1 border-0 text-[10px] ${
                      estado === "abierta" ? "bg-success-light text-success"
                        : estado === "cerrada" ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground"
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        estado === "abierta" ? "bg-success"
                          : estado === "cerrada" ? "bg-destructive" : "bg-muted-foreground"
                      }`} />
                      {estado === "abierta" ? "Abierta" : estado === "cerrada" ? "Cerrada" : "Sin iniciar"}
                    </Badge>
                  </div>

                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <Bandera moneda={moneda} size={16} />
                    <span className="truncate font-semibold text-foreground">{pais}</span>
                    {ciudad && <span className="truncate">· {ciudad}</span>}
                  </p>
                </div>
              </div>

              {/* Clientes y horario */}
              <div className="grid shrink-0 grid-cols-2 gap-1.5 sm:w-[300px]">
                <div className="rounded-md border bg-muted/20 px-1.5 py-1">
                  <p className="flex items-center gap-1 text-[9px] leading-none text-muted-foreground">
                    <Users className="h-3 w-3 shrink-0" />
                    Clientes asignados
                  </p>
                  <p className="text-base font-bold leading-tight tabular-nums text-foreground">{clientes}</p>
                </div>
                <div className="rounded-md border bg-muted/20 px-1.5 py-1">
                  <p className="flex items-center gap-1 text-[9px] leading-none text-muted-foreground">
                    <Clock className="h-3 w-3 shrink-0" />
                    Jornada
                  </p>
                  {/* LA HORA ES LA REAL, no una planificada: sale de
                      `rutas_diarias.hora_inicio/hora_fin`, que es cuando el
                      cobrador toco Iniciar y Cerrar. Un "08:00 – 17:00" fijo
                      seria un horario inventado. */}
                  <p className="text-[11px] font-semibold leading-tight text-foreground">
                    {horaInicio ? `Inicio ${horaColombia(horaInicio)}` : "Sin iniciar"}
                  </p>
                  <p className="text-[10px] leading-tight text-muted-foreground">
                    {horaFin ? `Cierre ${horaColombia(horaFin)}` : estado === "abierta" ? "En curso" : "—"}
                  </p>
                </div>
              </div>
              </div>
            </CardContent>
          </Card>

          {/* ── La gente a cargo ─────────────────────────────────────────
              UNA sola tarjeta con los cuatro en fila, separados por una raya
              —no cuatro tarjetas sueltas—, como el diseño.

              Tarjetero y Supervisor van como "Sin asignar": en este sistema
              no existen esos roles todavia. */}
          <Card className="border-0 bg-card shadow-sm">
            <CardContent className="grid grid-cols-2 gap-x-2 gap-y-1 p-1.5 md:grid-cols-4 md:divide-x md:divide-border">
              {[
                { label: "Unidad / Moto", valor: motoPlaca, activa: !!motoPlaca, icono: Bike, color: "text-info" },
                { label: "Cobrador", valor: cobrador, activa: false, icono: User, color: "text-brand" },
                { label: "Tarjetero", valor: null, activa: false, icono: CreditCard, color: "text-muted-foreground" },
                { label: "Supervisor", valor: null, activa: false, icono: ShieldCheck, color: "text-muted-foreground" },
              ].map((c, i) => (
                <div key={c.label} className={`flex items-center gap-1.5 ${i > 0 ? "md:pl-2" : ""}`}>
                  <c.icono className={`h-4 w-4 shrink-0 ${c.color}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[9px] leading-none text-muted-foreground">{c.label}</p>
                    <p className={`truncate text-[11px] font-bold leading-tight ${
                      c.valor ? "text-foreground" : "text-muted-foreground"
                    }`}>
                      {c.valor ?? "Sin asignar"}
                    </p>
                  </div>
                  {c.activa && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />}
                </div>
              ))}
            </CardContent>
          </Card>

          {/* ── Resumen de la ruta ─────────────────────────────────────────
              Los tres datos EN UNA LINEA: debido y cobrado ocupan lo que
              miden sus cifras —no media pantalla cada uno— y el avance se
              queda con el resto, que es lo que necesita para que la barra se
              lea. */}
          <Card className="border-0 bg-card shadow-sm">
            <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 p-1.5">
              <p className="shrink-0 text-[11px] font-bold text-foreground">
                Resumen{moneda ? ` (${moneda})` : ""}
              </p>
              <div className="shrink-0">
                <p className="text-[9px] leading-none text-muted-foreground">Debido cobrar</p>
                <p className="whitespace-nowrap text-sm font-bold leading-tight tabular-nums text-foreground">
                  {formatearMoneda(debido, moneda)}
                </p>
              </div>
              <div className="shrink-0">
                <p className="text-[9px] leading-none text-muted-foreground">Cobrado</p>
                <p className="whitespace-nowrap text-sm font-bold leading-tight tabular-nums text-success">
                  {formatearMoneda(cobrado, moneda)}
                </p>
              </div>
              <div className="flex min-w-[130px] flex-1 items-center gap-1.5">
                <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">
                  {pct === null ? "—" : `${pct}%`}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full ${tono}`} style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── Los seis contadores ────────────────────────────────────────
              UNA tarjeta con los seis en columnas, no seis tarjetas. */}
          <Card className="border-0 bg-card shadow-sm">
            <CardContent className="grid grid-cols-6 divide-x divide-border p-1">
              {contadores.map((c) => (
                <div key={c.label} className="px-0.5 text-center">
                  <c.icono className={`mx-auto h-3.5 w-3.5 ${c.color}`} />
                  <p className="truncate text-[9px] leading-none text-muted-foreground">{c.label}</p>
                  <p className={`text-sm font-bold leading-tight tabular-nums ${c.color}`}>{c.valor}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* ── Las pestañas ─────────────────────────────────────────────── */}
          <Card className="border-0 bg-card shadow-sm">
            <CardContent className="p-0">
              {/* Subrayadas y repartidas, como el diseño. El borde de abajo
                  marca cual esta activa en vez de una pastilla de color. */}
              <div className="flex border-b">
                {pestanas.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPestana(p.id)}
                    className={`flex flex-1 items-center justify-center gap-1 border-b-2 px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                      pestana === p.id
                        ? "border-brand text-brand"
                        : "border-transparent text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    <p.icono className="h-3.5 w-3.5 shrink-0" />
                    {p.label}
                    <span className={`rounded-full px-1 text-[9px] tabular-nums ${
                      pestana === p.id ? "bg-brand/10" : "bg-muted"
                    }`}>{p.n}</span>
                  </button>
                ))}
              </div>

              {pestana === "clientes" && (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="px-1.5 py-1 text-[9px] font-bold uppercase text-muted-foreground">#</TableHead>
                      <TableHead className="px-1.5 py-1 text-[9px] font-bold uppercase text-muted-foreground">Cliente</TableHead>
                      <TableHead className="px-1.5 py-1 text-right text-[9px] font-bold uppercase text-muted-foreground">Cuota</TableHead>
                      <TableHead className="px-1.5 py-1 text-center text-[9px] font-bold uppercase text-muted-foreground">Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {clientesFiltrados.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="py-8 text-center text-xs text-muted-foreground">
                          {q ? "Ningún cliente con esa búsqueda." : "Nadie tenía cuota ese día en esta unidad."}
                        </TableCell>
                      </TableRow>
                    ) : clientesFiltrados.map((c, i) => (
                      <TableRow key={c.loanId} className="border-b border-border/50 hover:bg-muted/20">
                        <TableCell className="px-1.5 py-1 text-[10px] text-muted-foreground">{i + 1}</TableCell>
                        {/* La direccion y la zona van DEBAJO del nombre: con
                            columna propia, Cuota y Estado se salen de un
                            telefono de 390px y hay que arrastrar de lado para
                            ver si el cliente pago. */}
                        <TableCell className="px-1.5 py-1">
                          <span className="block text-xs font-semibold leading-tight text-foreground">{c.nombre}</span>
                          {(c.direccion || c.zona) && (
                            <span className="block text-[10px] leading-tight text-muted-foreground">
                              {[c.direccion, c.zona].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap px-1.5 py-1 text-right text-[11px] font-bold tabular-nums">
                          {fmtMoneda(c.cuota)}
                        </TableCell>
                        <TableCell className="px-1.5 py-1 text-center">
                          <Badge className={`border-0 text-[10px] ${
                            c.estado === "pago" ? "bg-success-light text-success"
                              : c.estado === "no_pago" ? "bg-destructive/10 text-destructive"
                                : "bg-muted text-muted-foreground"
                          }`}>
                            {c.estado === "pago" ? "Pagó" : c.estado === "no_pago" ? "No pagó" : "Pendiente"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {pestana === "mapa" && (
                /* EL RECORRIDO DEL DIA. Reusa el mapa del Monitoreo de Rutas,
                   que ya numera las paradas en orden y las pinta por estado.
                   Sin puntos se dice por que, en vez de dejar un cuadro gris
                   que se lee como que el mapa se rompio. */
                puntos.length === 0 ? (
                  <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                    Sin ubicaciones registradas ese día. El recorrido se dibuja
                    con el GPS de cada gestión.
                  </p>
                ) : (
                  <div className="h-[300px] w-full overflow-hidden">
                    <MapaRuta points={puntos} />
                  </div>
                )
              )}

              {pestana === "movimientos" && (
                /* Gestiones Y gastos/ingresos/retiros en una sola lista,
                   ordenada por hora: es "que paso hoy", y separarlos en dos
                   pestañas obligaba a saltar entre ellas para reconstruir el
                   dia. */
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="px-1.5 py-1 text-[9px] font-bold uppercase text-muted-foreground">Hora</TableHead>
                      <TableHead className="px-1.5 py-1 text-[9px] font-bold uppercase text-muted-foreground">Detalle</TableHead>
                      <TableHead className="px-1.5 py-1 text-right text-[9px] font-bold uppercase text-muted-foreground">Monto</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movsFiltrados.length + gastosFiltrados.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="py-6 text-center text-xs text-muted-foreground">
                          Sin movimientos ese día.
                        </TableCell>
                      </TableRow>
                    ) : [
                      ...movsFiltrados.map((m) => ({
                        k: `g-${m.id}`, hora: m.hora, titulo: m.cliente, sub: m.tipo,
                        monto: m.monto, positivo: m.monto > 0,
                      })),
                      ...gastosFiltrados.map((g) => ({
                        k: `x-${g.id}`, hora: g.hora, titulo: g.concepto, sub: g.tipo,
                        monto: g.valor, positivo: g.tipo === "Ingreso",
                      })),
                    ]
                      .sort((a, b) => a.hora.localeCompare(b.hora))
                      .map((r) => (
                        <TableRow key={r.k} className="border-b border-border/50 hover:bg-muted/20">
                          <TableCell className="whitespace-nowrap px-1.5 py-1 text-[10px] text-muted-foreground">{r.hora}</TableCell>
                          <TableCell className="px-1.5 py-1">
                            <span className="block text-[11px] font-semibold leading-tight text-foreground">{r.titulo}</span>
                            <span className="block text-[9px] capitalize leading-tight text-muted-foreground">{r.sub}</span>
                          </TableCell>
                          <TableCell className={`whitespace-nowrap px-1.5 py-1 text-right text-[11px] font-bold tabular-nums ${
                            r.monto === 0 ? "text-muted-foreground" : r.positivo ? "text-success" : "text-destructive"
                          }`}>
                            {r.monto === 0 ? "—" : fmtMoneda(r.monto)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
