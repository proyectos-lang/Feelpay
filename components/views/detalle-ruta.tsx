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
import { createClient } from "@/lib/supabase/client"
import { getResumenDia } from "@/lib/resumen-dia"
import {
  todayColombia,
  horaColombia,
  fmtMoneda,
  montoEfectivo,
} from "@/lib/gestion-core"
import { Bandera } from "@/components/bandera"
import { formatearMoneda, monedaPorPais } from "@/lib/monedas"

type Pestana = "clientes" | "movimientos" | "gastos"

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

/** "2026-09-20" → "20 de septiembre de 2026". */
function fechaLarga(iso: string): string {
  const [a, m, d] = iso.split("-").map(Number)
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
    "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
  return `${d} de ${meses[m - 1]} de ${a}`
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
          .select("id, loan_id, tipo, monto, fecha_hora, loans:loans(clients:clients(nombre_completo))")
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
      for (const g of (resGest.data ?? []) as unknown as {
        id: string; loan_id: string; tipo: string; monto: number | null; fecha_hora: string
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
      }
      setMovimientos(movs)

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
    { id: "movimientos", label: "Movimientos", icono: CreditCard, n: movimientos.length },
    { id: "gastos", label: "Gastos", icono: Receipt, n: gastos.length },
  ]

  return (
    <div className="space-y-2">
      {/* ── Fecha, ruta y buscador ─────────────────────────────────────────── */}
      <Card className="border-0 bg-card shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-1.5 px-2.5 py-2">
          <Input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className="h-8 w-[136px] text-xs"
          />
          <Select value={rutaId != null ? String(rutaId) : ""} onValueChange={(v) => setRutaId(Number(v))}>
            <SelectTrigger className="h-8 w-[142px] text-xs">
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
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Button size="icon" variant="outline" onClick={() => void cargar()} className="h-8 w-8 shrink-0">
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
              <div className="flex flex-1 items-start gap-2.5">
                {motoFoto ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={motoFoto}
                    alt={`Moto de ${nombre}`}
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
                  <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <MapPin className="h-3 w-3 shrink-0" />
                    {fechaLarga(fecha)}
                  </p>
                </div>
              </div>

              {/* Clientes y horario */}
              <div className="grid shrink-0 grid-cols-2 gap-1.5 sm:w-[300px]">
                <div className="rounded-lg border bg-muted/20 px-2 py-1.5">
                  <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Users className="h-3 w-3 shrink-0" />
                    Clientes asignados
                  </p>
                  <p className="text-base font-bold leading-tight tabular-nums text-foreground">{clientes}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 px-2 py-1.5">
                  <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
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

          {/* ── La gente a cargo ─────────────────────────────────────────── */}
          {/* Tarjetero y Supervisor van como "Sin asignar": en este sistema no
              existen esos roles todavia. El hueco queda a la vista, listo para
              llenarse el dia que se definan. */}
          <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
            {[
              { label: "Unidad / Moto", valor: motoPlaca, extra: motoPlaca ? "Activa" : null, icono: Bike, color: "text-info" },
              { label: "Cobrador", valor: cobrador, extra: null, icono: User, color: "text-brand" },
              { label: "Tarjetero", valor: null, extra: null, icono: CreditCard, color: "text-muted-foreground" },
              { label: "Supervisor", valor: null, extra: null, icono: ShieldCheck, color: "text-muted-foreground" },
            ].map((c) => (
              <Card key={c.label} className="border-0 bg-card shadow-sm">
                <CardContent className="flex items-center gap-2 px-2 py-1">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted/50">
                    <c.icono className={`h-4 w-4 ${c.color}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] leading-tight text-muted-foreground">{c.label}</p>
                    <p className={`truncate text-xs font-bold leading-tight ${
                      c.valor ? "text-foreground" : "text-muted-foreground"
                    }`}>
                      {c.valor ?? "Sin asignar"}
                    </p>
                    {c.extra && (
                      <p className="flex items-center gap-1 text-[10px] leading-tight text-success">
                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                        {c.extra}
                      </p>
                    )}
                    {!c.valor && (
                      <p className="flex items-center gap-0.5 text-[10px] leading-tight text-muted-foreground">
                        <Plus className="h-2.5 w-2.5" />
                        Sin registrar
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* ── Resumen de la ruta ───────────────────────────────────────── */}
          <Card className="border-0 bg-card shadow-sm">
            <CardContent className="px-3 py-2">
              <p className="mb-1.5 text-xs font-bold text-foreground">
                Resumen de la ruta{moneda ? ` (${moneda})` : ""}
              </p>
              {/* Las tres cajas en fila, como el diseño: cada dato en su
                  recuadro y el avance ocupando el doble. */}
              <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
                <div className="min-w-0 rounded-lg border bg-muted/20 px-2 py-1.5">
                  <p className="text-[10px] leading-tight text-muted-foreground">Debido cobrar</p>
                  <p className="truncate text-base font-bold leading-tight tabular-nums text-foreground">
                    {formatearMoneda(debido, moneda)}
                  </p>
                </div>
                <div className="min-w-0 rounded-lg border bg-muted/20 px-2 py-1.5">
                  <p className="text-[10px] leading-tight text-muted-foreground">Cobrado</p>
                  <p className="truncate text-base font-bold leading-tight tabular-nums text-success">
                    {formatearMoneda(cobrado, moneda)}
                  </p>
                </div>
                <div className="col-span-2 min-w-0 rounded-lg border bg-muted/20 px-2 py-1.5">
                  <p className="text-[10px] leading-tight text-muted-foreground">Avance</p>
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-base font-bold tabular-nums text-foreground">
                      {pct === null ? "sin meta" : `${pct}%`}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className={`h-full rounded-full ${tono}`} style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── Los seis contadores ──────────────────────────────────────── */}
          <div className="grid grid-cols-3 gap-1.5 md:grid-cols-6">
            {contadores.map((c) => (
              <Card key={c.label} className="border-0 bg-card shadow-sm">
                <CardContent className="px-2 py-1.5 text-center">
                  <c.icono className={`mx-auto h-4 w-4 ${c.color}`} />
                  <p className="text-[10px] leading-tight text-muted-foreground">{c.label}</p>
                  <p className={`text-base font-bold leading-tight tabular-nums ${c.color}`}>{c.valor}</p>
                </CardContent>
              </Card>
            ))}
          </div>

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
                    className={`flex flex-1 items-center justify-center gap-1 border-b-2 px-2 py-2 text-[11px] font-semibold transition-colors ${
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
                      <TableHead className="px-2 py-2 text-[10px] font-bold uppercase text-muted-foreground">#</TableHead>
                      <TableHead className="px-2 py-2 text-[10px] font-bold uppercase text-muted-foreground">Cliente</TableHead>
                      <TableHead className="px-2 py-2 text-right text-[10px] font-bold uppercase text-muted-foreground">Cuota</TableHead>
                      <TableHead className="px-2 py-2 text-center text-[10px] font-bold uppercase text-muted-foreground">Estado</TableHead>
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
                        <TableCell className="px-2 py-1.5 text-[10px] text-muted-foreground">{i + 1}</TableCell>
                        {/* La direccion y la zona van DEBAJO del nombre: con
                            columna propia, Cuota y Estado se salen de un
                            telefono de 390px y hay que arrastrar de lado para
                            ver si el cliente pago. */}
                        <TableCell className="px-2 py-1.5">
                          <span className="block text-xs font-semibold leading-tight text-foreground">{c.nombre}</span>
                          {(c.direccion || c.zona) && (
                            <span className="block text-[10px] leading-tight text-muted-foreground">
                              {[c.direccion, c.zona].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap px-2 py-1.5 text-right text-xs font-bold tabular-nums">
                          {fmtMoneda(c.cuota)}
                        </TableCell>
                        <TableCell className="px-2 py-1.5 text-center">
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

              {pestana === "movimientos" && (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="px-2 py-2 text-[10px] font-bold uppercase text-muted-foreground">Hora</TableHead>
                      <TableHead className="px-2 py-2 text-[10px] font-bold uppercase text-muted-foreground">Cliente</TableHead>
                      <TableHead className="px-2 py-2 text-right text-[10px] font-bold uppercase text-muted-foreground">Monto</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movsFiltrados.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="py-8 text-center text-xs text-muted-foreground">
                          Sin movimientos ese día.
                        </TableCell>
                      </TableRow>
                    ) : movsFiltrados.map((m) => (
                      <TableRow key={m.id} className="border-b border-border/50 hover:bg-muted/20">
                        <TableCell className="whitespace-nowrap px-2 py-1.5 text-[10px] text-muted-foreground">{m.hora}</TableCell>
                        <TableCell className="px-2 py-1.5">
                          <span className="block text-xs font-semibold leading-tight text-foreground">{m.cliente}</span>
                          <span className="block text-[10px] capitalize leading-tight text-muted-foreground">{m.tipo}</span>
                        </TableCell>
                        <TableCell className={`whitespace-nowrap px-2 py-1.5 text-right text-xs font-bold tabular-nums ${
                          m.monto > 0 ? "text-success" : m.monto < 0 ? "text-destructive" : "text-muted-foreground"
                        }`}>
                          {m.monto === 0 ? "—" : fmtMoneda(m.monto)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {pestana === "gastos" && (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="px-2 py-2 text-[10px] font-bold uppercase text-muted-foreground">Hora</TableHead>
                      <TableHead className="px-2 py-2 text-[10px] font-bold uppercase text-muted-foreground">Concepto</TableHead>
                      <TableHead className="px-2 py-2 text-right text-[10px] font-bold uppercase text-muted-foreground">Valor</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {gastosFiltrados.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="py-8 text-center text-xs text-muted-foreground">
                          Sin gastos, ingresos ni retiros ese día.
                        </TableCell>
                      </TableRow>
                    ) : gastosFiltrados.map((g) => (
                      <TableRow key={g.id} className="border-b border-border/50 hover:bg-muted/20">
                        <TableCell className="whitespace-nowrap px-2 py-1.5 text-[10px] text-muted-foreground">{g.hora}</TableCell>
                        <TableCell className="px-2 py-1.5">
                          <span className="block text-xs font-semibold leading-tight text-foreground">{g.concepto}</span>
                          <span className="block text-[10px] leading-tight text-muted-foreground">{g.tipo}</span>
                        </TableCell>
                        <TableCell className={`whitespace-nowrap px-2 py-1.5 text-right text-xs font-bold tabular-nums ${
                          g.tipo === "Ingreso" ? "text-success" : "text-destructive"
                        }`}>
                          {fmtMoneda(g.valor)}
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
