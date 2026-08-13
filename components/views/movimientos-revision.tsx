"use client"

/**
 * Movimientos en Revisión
 * -----------------------
 * Bandeja de secretaría. No es solo "lo que me toca aprobar": muestra TODO
 * lo registrado y en qué punto va cada cosa, porque antes un movimiento que
 * quedaba esperando al admin desaparecía de su vista y nadie sabía por qué
 * no avanzaba (había gastos detenidos siete meses sin que nada lo gritara).
 *
 * Se juntan dos fuentes que hoy conviven en la app:
 *
 *   · `solicitudes_revision` — lo que superó el UMBRAL DE LA RUTA. Aquí caen
 *     gastos, ventas y abonos, y los aprueba secretaría.
 *   · `gastosregistros` — la cadena vieja, por el LÍMITE DEL ÍTEM: primero
 *     el admin y después secretaría. Solo gastos, ingresos y retiros; las
 *     ventas y los abonos nunca pasan por el admin.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { callRpcAtomic, getSessionIdentity } from "@/lib/api-helper"
import { getSolicitanteNombre } from "@/lib/ruta-umbrales"
import { saveTransaction } from "@/lib/actions/save-transaction"
import { approveTransaction } from "@/lib/actions/approve-transaction"
import { approveTransactionSecretary } from "@/lib/actions/approve-transaction-secretary"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { Loader2, ShieldCheck, CheckCircle2, XCircle, Wallet, ShoppingBag, HandCoins, Clock, AlertTriangle } from "lucide-react"

type Tipo = "gasto" | "venta" | "abono"

/** En qué punto del circuito está el movimiento. */
type EstadoBandeja = "pendiente_mio" | "espera_admin" | "aprobado" | "rechazado"

interface Solicitud {
  id: string
  tipo: Tipo
  subtipo: "nueva" | "renovacion" | null
  ruta_id: number
  solicitado_por_nombre: string | null
  monto: number
  descripcion: string | null
  payload: Record<string, unknown>
  estado: string
  created_at: string
}

interface MovimientoCaja {
  id: number
  ruta: number
  tipo: string
  concepto: string
  valor: number
  observacion: string | null
  estadoadmin: string
  estadosecre: string
  adminaprobo: string | null
  secretariaaprobo: string | null
  fechahorasol: string
}

/** Fila normalizada de la bandeja, venga de donde venga. */
interface ItemBandeja {
  /** Prefijado por origen para no chocar entre las dos tablas. */
  key: string
  origen: "revision" | "caja"
  tipo: Tipo
  rutaId: number
  titulo: string
  subtitulo: string | null
  monto: number
  quien: string | null
  fecha: string
  estado: EstadoBandeja
  solicitud?: Solicitud
  movimiento?: MovimientoCaja
}

const TIPO_LABEL: Record<Tipo, string> = { gasto: "Gastos", venta: "Ventas", abono: "Abonos" }
const TIPO_ICON: Record<Tipo, typeof Wallet> = { gasto: Wallet, venta: ShoppingBag, abono: HandCoins }

const ESTADO_META: Record<EstadoBandeja, { label: string; clase: string }> = {
  pendiente_mio: { label: "Te toca aprobar", clase: "bg-amber-100 text-amber-800 border-amber-200" },
  espera_admin:  { label: "Esperando al admin", clase: "bg-sky-100 text-sky-800 border-sky-200" },
  aprobado:      { label: "Aprobado", clase: "bg-green-100 text-green-800 border-green-200" },
  rechazado:     { label: "Rechazado", clase: "bg-red-100 text-red-800 border-red-200" },
}

function formatMonto(n: number): string {
  return `$${Math.round(n).toLocaleString("es-CO")}`
}

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

/** Dias que lleva esperando un movimiento. */
function diasEsperando(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

export function MovimientosRevision() {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<Tipo>("gasto")
  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([])
  const [movimientos, setMovimientos] = useState<MovimientoCaja[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<ItemBandeja | null>(null)
  const [motivo, setMotivo] = useState("")
  // Confirmacion aparte para cuando secretaria resuelve algo que le tocaba
  // al admin: salta un control y conviene que sea un acto deliberado.
  const [overrideTarget, setOverrideTarget] = useState<ItemBandeja | null>(null)

  // La bandeja es de TODAS las rutas a proposito: secretaria atiende varias y
  // filtrarla a la ruta seleccionada le esconderia el resto sin avisarle.
  const [rutas, setRutas] = useState<Map<number, string>>(new Map())
  const [rutaFiltro, setRutaFiltro] = useState<number | "todas">("todas")
  const [estadoFiltro, setEstadoFiltro] = useState<EstadoBandeja | "todos">("pendiente_mio")

  // Seleccion para aprobar en lote. Aprobar veinte gastos de alimentacion
  // uno por uno era el trabajo diario de secretaria.
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set())
  const [aprobandoLote, setAprobandoLote] = useState(false)

  const fetchTodo = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const [{ data: solData, error }, { data: cajaData }, { data: rutasData }] = await Promise.all([
        supabase
          .from("solicitudes_revision")
          .select("*")
          .order("created_at", { ascending: true }),
        // Solo los movimientos que pasaron por algun control. Los que nunca
        // necesitaron aprobacion (estadoadmin y estadosecre en 'NA') no
        // pertenecen a una bandeja de revision y solo harian ruido.
        supabase
          .from("gastosregistros")
          .select("id, ruta, tipo, concepto, valor, observacion, estadoadmin, estadosecre, adminaprobo, secretariaaprobo, fechahorasol")
          .or("estadoadmin.neq.NA,estadosecre.neq.NA")
          .order("fechahorasol", { ascending: false })
          .limit(300),
        supabase.from("rutas").select("id, nombre").order("id"),
      ])
      if (error) throw error
      setSolicitudes((solData ?? []) as Solicitud[])
      setMovimientos((cajaData ?? []) as MovimientoCaja[])
      setRutas(new Map(((rutasData ?? []) as { id: number; nombre: string }[]).map((r) => [r.id, r.nombre])))
    } catch (err) {
      console.error("[v0] Error cargando la bandeja de revision:", err)
      toast({
        title: "Error",
        description: "No se pudo cargar la bandeja de movimientos.",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { fetchTodo() }, [fetchTodo])

  const nombreRuta = useCallback(
    (id: number) => rutas.get(id) ?? `Ruta ${id}`,
    [rutas],
  )

  // ── Normalizacion de las dos fuentes ───────────────────────────────────
  const bandeja = useMemo<ItemBandeja[]>(() => {
    const desdeRevision: ItemBandeja[] = solicitudes
      // Un gasto aprobado ya existe como movimiento real en `gastosregistros`
      // y desde ahi se ve su estado verdadero (puede seguir esperando al
      // admin). Mostrar tambien la solicitud lo duplicaria, y ademas diria
      // "aprobado" sobre plata que todavia no termina de pasar el circuito.
      // Los rechazados si se conservan: esos nunca llegaron a ser movimiento.
      .filter((s) => !(s.tipo === "gasto" && s.estado === "aprobado"))
      .map((s) => ({
      key: `sr:${s.id}`,
      origen: "revision",
      tipo: s.tipo,
      rutaId: s.ruta_id,
      titulo: s.descripcion ?? TIPO_LABEL[s.tipo],
      subtitulo: s.subtipo ? (s.subtipo === "nueva" ? "Nueva" : "Renovación") : null,
      monto: Number(s.monto ?? 0),
      quien: s.solicitado_por_nombre,
      fecha: s.created_at,
      estado:
        s.estado === "pendiente" ? "pendiente_mio"
        : s.estado === "rechazado" ? "rechazado"
        : "aprobado",
      solicitud: s,
    }))

    const desdeCaja: ItemBandeja[] = movimientos.map((m) => ({
      key: `gr:${m.id}`,
      origen: "caja",
      // gastosregistros guarda Ingreso/Gasto/Retiro; en la bandeja los tres
      // viven bajo la pestaña de gastos, que es el movimiento de caja.
      tipo: "gasto",
      rutaId: m.ruta,
      titulo: `${m.tipo}: ${m.concepto}`,
      subtitulo: m.observacion || null,
      monto: Number(m.valor ?? 0),
      quien: m.secretariaaprobo || m.adminaprobo || null,
      fecha: m.fechahorasol,
      estado:
        m.estadoadmin === "rechazado" || m.estadosecre === "rechazado" ? "rechazado"
        : m.estadoadmin === "por aprobar" ? "espera_admin"
        : m.estadosecre === "por aprobar" ? "pendiente_mio"
        : "aprobado",
      movimiento: m,
    }))

    return [...desdeRevision, ...desdeCaja].sort((a, b) => {
      // Lo que necesita accion primero, y dentro de eso lo mas viejo arriba.
      const pesoA = a.estado === "pendiente_mio" ? 0 : a.estado === "espera_admin" ? 1 : 2
      const pesoB = b.estado === "pendiente_mio" ? 0 : b.estado === "espera_admin" ? 1 : 2
      if (pesoA !== pesoB) return pesoA - pesoB
      return pesoA === 2
        ? b.fecha.localeCompare(a.fecha)   // resueltos: lo mas reciente arriba
        : a.fecha.localeCompare(b.fecha)   // pendientes: lo mas viejo arriba
    })
  }, [solicitudes, movimientos])

  const visibles = useMemo(
    () => bandeja.filter((i) => (rutaFiltro === "todas" || i.rutaId === rutaFiltro)),
    [bandeja, rutaFiltro],
  )
  const porEstado = useMemo(
    () => visibles.filter((i) => estadoFiltro === "todos" || i.estado === estadoFiltro),
    [visibles, estadoFiltro],
  )
  const filtered = useMemo(() => porEstado.filter((i) => i.tipo === activeTab), [porEstado, activeTab])

  const counts = {
    gasto: porEstado.filter((i) => i.tipo === "gasto").length,
    venta: porEstado.filter((i) => i.tipo === "venta").length,
    abono: porEstado.filter((i) => i.tipo === "abono").length,
  }
  const rutasEnBandeja = Array.from(new Set(bandeja.map((i) => i.rutaId))).sort((a, b) => a - b)

  /** Un item se puede resolver desde aquí. */
  const esAccionable = (i: ItemBandeja) => i.estado === "pendiente_mio" || i.estado === "espera_admin"

  // ── Aplicar una aprobación ─────────────────────────────────────────────
  /**
   * Aplica UN item. Lanza si algo falla, para que quien la llama decida si
   * avisa o si sigue con el siguiente (aprobación en lote).
   */
  const aprobarUno = async (i: ItemBandeja) => {
    // --- Movimiento de caja de la cadena vieja -------------------------
    if (i.origen === "caja" && i.movimiento) {
      const nombre = getSolicitanteNombre() ?? "Secretaría"
      if (i.estado === "espera_admin") {
        // Resolver en lugar del admin. Queda marcado en `adminaprobo` para
        // que en la auditoría no se confunda con una aprobación del admin.
        const r = await approveTransaction({
          id: i.movimiento.id,
          status: "aprobado",
          adminName: nombre,
          enLugarDelAdmin: true,
        })
        if (!r.success) throw new Error(r.error ?? "No se pudo aprobar el movimiento")
      } else {
        const r = await approveTransactionSecretary({
          id: i.movimiento.id,
          status: "aprobado",
          secretaryName: nombre,
        })
        if (!r.success) throw new Error(r.error ?? "No se pudo aprobar el movimiento")
      }
      return
    }

    // --- Solicitud del umbral de ruta -----------------------------------
    const s = i.solicitud!
    if (s.tipo === "gasto") {
      // Camino asimetrico: el gasto se aplica llamando saveTransaction()
      // (server action existente, sin cambios porque sube fotos a Vercel
      // Blob) en vez de resolverse dentro de una RPC.
      //
      // Por eso hay que RECLAMAR la solicitud antes de aplicarla. Antes se
      // registraba el gasto primero y se marcaba la solicitud despues: si
      // ese segundo paso fallaba, la solicitud seguia apareciendo y al
      // aprobarla otra vez entraba un segundo gasto. Dos personas
      // aprobando a la vez producian lo mismo. El `.eq("estado",
      // "pendiente")` hace que solo una de las dos se lo lleve.
      const identity = getSessionIdentity()
      const supabase = createClient()
      const { data: reclamada, error: reclamoErr } = await supabase
        .from("solicitudes_revision")
        .update({ estado: "aprobado", revisado_por: identity.user_id, revisado_at: new Date().toISOString() })
        .eq("id", s.id)
        .eq("estado", "pendiente")
        .select("id")
      if (reclamoErr) throw reclamoErr
      if (!reclamada || reclamada.length === 0) {
        throw new Error("Este movimiento ya fue resuelto por otra persona")
      }

      // El id de la solicitud sirve de llave de idempotencia: aunque esto
      // se reintente, el gasto entra una sola vez.
      const result = await saveTransaction({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(s.payload as any),
        idempotencyKey: s.id,
        aprobadoPorSecretaria: getSolicitanteNombre() ?? undefined,
      })
      if (!result.success) {
        // Se devuelve a pendiente para que se pueda reintentar; si no,
        // quedaria marcada como aprobada sin gasto registrado.
        await supabase
          .from("solicitudes_revision")
          .update({ estado: "pendiente", revisado_por: null, revisado_at: null })
          .eq("id", s.id)
        throw new Error(result.error ?? "No se pudo registrar el gasto")
      }
    } else {
      // venta / abono: RPC atomica, cascada incluida (crea el prestamo +
      // plan de pagos, o aplica el abono, en una sola transaccion)
      await callRpcAtomic("aprobar_solicitud_revision", { solicitud_id: s.id, decision: "aprobado" })
    }
  }

  const quitarSeleccion = (key: string) => {
    setSeleccion((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  const handleAprobar = async (i: ItemBandeja) => {
    setActionLoadingKey(i.key)
    try {
      await aprobarUno(i)
      quitarSeleccion(i.key)
      toast({ title: i.estado === "espera_admin" ? "Aprobado en lugar del admin" : "Movimiento aprobado" })
      await fetchTodo()
    } catch (err) {
      console.error("[v0] Error aprobando:", err)
      toast({
        title: "Error al aprobar",
        description: err instanceof Error ? err.message : "No se pudo aprobar el movimiento",
        variant: "destructive",
      })
    } finally {
      setActionLoadingKey(null)
      setOverrideTarget(null)
    }
  }

  /**
   * Aprueba lo seleccionado, UNO A UNO y en serie.
   *
   * En serie a proposito: cada aprobacion escribe en loans/payment_plan o en
   * gastosregistros, y lanzarlas en paralelo multiplicaria las carreras que
   * justamente se acaban de cerrar. Si una falla, se sigue con las demas y al
   * final se informa cuantas quedaron.
   */
  const handleAprobarLote = async () => {
    const aAprobar = filtered.filter((i) => seleccion.has(i.key) && esAccionable(i))
    if (aAprobar.length === 0) return
    setAprobandoLote(true)
    let ok = 0
    const fallidas: string[] = []
    for (const i of aAprobar) {
      setActionLoadingKey(i.key)
      try {
        await aprobarUno(i)
        quitarSeleccion(i.key)
        ok += 1
      } catch (err) {
        console.error("[v0] Error aprobando en lote:", i.key, err)
        fallidas.push(i.titulo)
      }
    }
    setActionLoadingKey(null)
    setAprobandoLote(false)
    toast({
      title: `${ok} de ${aAprobar.length} aprobados`,
      description: fallidas.length > 0 ? `No se pudieron aprobar: ${fallidas.join(", ")}` : undefined,
      variant: fallidas.length > 0 ? "destructive" : undefined,
    })
    await fetchTodo()
  }

  const handleRechazar = async () => {
    if (!rejectTarget) return
    const i = rejectTarget
    setActionLoadingKey(i.key)
    try {
      if (i.origen === "caja" && i.movimiento) {
        const nombre = getSolicitanteNombre() ?? "Secretaría"
        const r = i.estado === "espera_admin"
          ? await approveTransaction({ id: i.movimiento.id, status: "rechazado", adminName: nombre, enLugarDelAdmin: true })
          : await approveTransactionSecretary({ id: i.movimiento.id, status: "rechazado", secretaryName: nombre })
        if (!r.success) throw new Error(r.error ?? "No se pudo rechazar el movimiento")
      } else if (i.solicitud?.tipo === "gasto") {
        const identity = getSessionIdentity()
        const { error } = await createClient()
          .from("solicitudes_revision")
          .update({
            estado: "rechazado",
            revisado_por: identity.user_id,
            revisado_at: new Date().toISOString(),
            motivo_rechazo: motivo || null,
          })
          .eq("id", i.solicitud.id)
          .eq("estado", "pendiente")
        if (error) throw error
      } else if (i.solicitud) {
        await callRpcAtomic("aprobar_solicitud_revision", {
          solicitud_id: i.solicitud.id,
          decision: "rechazado",
          motivo_rechazo: motivo || null,
        })
      }
      quitarSeleccion(i.key)
      toast({ title: "Movimiento rechazado" })
      await fetchTodo()
    } catch (err) {
      console.error("[v0] Error rechazando:", err)
      toast({
        title: "Error al rechazar",
        description: err instanceof Error ? err.message : "No se pudo rechazar el movimiento",
        variant: "destructive",
      })
    } finally {
      setActionLoadingKey(null)
      setRejectTarget(null)
      setMotivo("")
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const chipsEstado: { key: EstadoBandeja | "todos"; label: string }[] = [
    { key: "pendiente_mio", label: "Te toca aprobar" },
    { key: "espera_admin", label: "Esperando al admin" },
    { key: "aprobado", label: "Aprobados" },
    { key: "rechazado", label: "Rechazados" },
    { key: "todos", label: "Todos" },
  ]

  const pendientesDeAccion = visibles.filter((i) => esAccionable(i))
  const masViejo = pendientesDeAccion.reduce<number>((max, i) => Math.max(max, diasEsperando(i.fecha)), 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-border overflow-hidden p-0.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
        </div>
        <div>
          <h2 className="text-base md:text-lg font-bold leading-tight">Movimientos en Revisión</h2>
          <p className="text-[11px] text-muted-foreground">Gastos, ventas y abonos, y en qué punto va cada uno</p>
        </div>
      </div>

      {/* Aviso de antiguedad: sin esto los movimientos se quedaban meses sin
          que nada lo gritara. */}
      {pendientesDeAccion.length > 0 && masViejo >= 3 && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
          masViejo >= 15 ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"
        }`}>
          <Clock className="h-4 w-4 shrink-0" />
          <span>
            Hay <strong>{pendientesDeAccion.length}</strong> movimiento{pendientesDeAccion.length !== 1 ? "s" : ""} sin resolver.
            El más antiguo lleva <strong>{masViejo} días</strong> esperando.
          </span>
        </div>
      )}

      {/* Filtro por estado */}
      <div className="flex flex-wrap gap-1.5">
        {chipsEstado.map((c) => {
          const n = c.key === "todos" ? visibles.length : visibles.filter((i) => i.estado === c.key).length
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => { setEstadoFiltro(c.key); setSeleccion(new Set()) }}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                estadoFiltro === c.key ? "border-brand bg-brand/10 font-semibold" : "hover:bg-muted/50"
              }`}
            >
              {c.label} ({n})
            </button>
          )
        })}
      </div>

      {/* Filtro por ruta */}
      {rutasEnBandeja.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-muted-foreground mr-1">Ruta:</span>
          <button
            type="button"
            onClick={() => setRutaFiltro("todas")}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              rutaFiltro === "todas" ? "border-brand bg-brand/10 font-semibold" : "hover:bg-muted/50"
            }`}
          >
            Todas
          </button>
          {rutasEnBandeja.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setRutaFiltro(id)}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                rutaFiltro === id ? "border-brand bg-brand/10 font-semibold" : "hover:bg-muted/50"
              }`}
            >
              {nombreRuta(id)}
            </button>
          ))}
        </div>
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tipo)}>
        <TabsList className="grid w-full max-w-md grid-cols-3">
          {(["gasto", "venta", "abono"] as Tipo[]).map((t) => (
            <TabsTrigger key={t} value={t} className="text-xs md:text-sm">
              {TIPO_LABEL[t]} ({counts[t]})
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
              <ShieldCheck className="h-8 w-8 opacity-30" />
              <p className="text-sm">
                {estadoFiltro === "espera_admin" && activeTab !== "gasto"
                  ? "Las ventas y los abonos no pasan por el admin: los aprueba secretaría."
                  : "Sin movimientos con estos filtros"}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Aprobacion en lote: solo sobre lo que se puede resolver */}
              {filtered.some((i) => esAccionable(i)) && (
                <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                  <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-current"
                      checked={filtered.filter(esAccionable).every((i) => seleccion.has(i.key))}
                      onChange={(e) => {
                        const marcar = e.target.checked
                        setSeleccion((prev) => {
                          const next = new Set(prev)
                          filtered.filter(esAccionable).forEach((i) => (marcar ? next.add(i.key) : next.delete(i.key)))
                          return next
                        })
                      }}
                    />
                    Seleccionar todo ({filtered.filter(esAccionable).length})
                  </label>
                  {filtered.some((i) => seleccion.has(i.key)) && (
                    <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={aprobandoLote} onClick={handleAprobarLote}>
                      {aprobandoLote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Aprobar {filtered.filter((i) => seleccion.has(i.key) && esAccionable(i)).length}
                    </Button>
                  )}
                </div>
              )}

              {filtered.map((i) => {
                const Icon = TIPO_ICON[i.tipo]
                const busy = actionLoadingKey === i.key
                const meta = ESTADO_META[i.estado]
                const dias = diasEsperando(i.fecha)
                const accionable = esAccionable(i)
                return (
                  <div key={i.key} className="rounded-xl border bg-card p-3 md:p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        {accionable && (
                          <input
                            type="checkbox"
                            className="mt-3 h-3.5 w-3.5 shrink-0 accent-current"
                            checked={seleccion.has(i.key)}
                            disabled={busy || aprobandoLote}
                            onChange={(e) => {
                              const marcar = e.target.checked
                              setSeleccion((prev) => {
                                const next = new Set(prev)
                                if (marcar) next.add(i.key); else next.delete(i.key)
                                return next
                              })
                            }}
                          />
                        )}
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-sm font-semibold truncate">{i.titulo}</p>
                            <span className={`rounded-full border px-1.5 py-0 text-[10px] font-semibold ${meta.clase}`}>
                              {meta.label}
                            </span>
                            {i.subtitulo && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">{i.subtitulo}</Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {nombreRuta(i.rutaId)} · {i.quien ?? "—"} · {formatFecha(i.fecha)}
                            {accionable && dias >= 3 && (
                              <span className={`ml-1 font-semibold ${dias >= 15 ? "text-red-600" : "text-amber-600"}`}>
                                · {dias} días esperando
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                      <p className="text-sm font-bold text-brand shrink-0 tabular-nums">{formatMonto(i.monto)}</p>
                    </div>

                    {accionable && (
                      <div className="flex justify-end gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
                          disabled={busy || aprobandoLote}
                          onClick={() => { setRejectTarget(i); setMotivo("") }}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Rechazar
                        </Button>
                        <Button
                          size="sm"
                          className="h-8 gap-1.5 text-xs"
                          disabled={busy || aprobandoLote}
                          onClick={() => (i.estado === "espera_admin" ? setOverrideTarget(i) : handleAprobar(i))}
                        >
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                          {i.estado === "espera_admin" ? "Aprobar por el admin" : "Aprobar"}
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Confirmacion de aprobar en lugar del admin */}
      <Dialog open={!!overrideTarget} onOpenChange={(open) => { if (!open) setOverrideTarget(null) }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <div className="flex items-center justify-center h-12 w-12 rounded-full bg-amber-100 mx-auto mb-2">
              <AlertTriangle className="h-6 w-6 text-amber-600" />
            </div>
            <DialogTitle className="text-center text-base">Aprobar en lugar del admin</DialogTitle>
            <DialogDescription className="text-center text-xs">
              Este movimiento superó el límite de su ítem, así que le correspondía al administrador revisarlo.
              Si lo apruebas tú, se salta esa revisión y queda registrado a tu nombre como aprobado en lugar del admin.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <p className="font-semibold">{overrideTarget?.titulo}</p>
            <p className="text-muted-foreground">
              {overrideTarget ? `${nombreRuta(overrideTarget.rutaId)} · ${formatMonto(overrideTarget.monto)}` : ""}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setOverrideTarget(null)}>Cancelar</Button>
            <Button
              size="sm"
              disabled={actionLoadingKey === overrideTarget?.key}
              onClick={() => overrideTarget && handleAprobar(overrideTarget)}
            >
              {actionLoadingKey === overrideTarget?.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Sí, aprobar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog motivo de rechazo */}
      <Dialog open={!!rejectTarget} onOpenChange={(open) => { if (!open) { setRejectTarget(null); setMotivo("") } }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Rechazar movimiento</DialogTitle>
            <DialogDescription>
              {rejectTarget?.titulo} — {rejectTarget ? formatMonto(rejectTarget.monto) : ""}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Motivo del rechazo (opcional)"
            className="text-sm"
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => { setRejectTarget(null); setMotivo("") }}>
              Cancelar
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleRechazar}
              disabled={actionLoadingKey === rejectTarget?.key}
            >
              {actionLoadingKey === rejectTarget?.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Rechazar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
