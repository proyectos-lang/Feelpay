"use client"

import { useCallback, useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { callRpcAtomic, getSessionIdentity } from "@/lib/api-helper"
import { getSolicitanteNombre } from "@/lib/ruta-umbrales"
import { saveTransaction } from "@/lib/actions/save-transaction"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { Loader2, ShieldCheck, CheckCircle2, XCircle, Wallet, ShoppingBag, HandCoins, Clock } from "lucide-react"

type Tipo = "gasto" | "venta" | "abono"

interface Solicitud {
  id: string
  tipo: Tipo
  subtipo: "nueva" | "renovacion" | null
  ruta_id: number
  solicitado_por_nombre: string | null
  monto: number
  descripcion: string | null
  payload: Record<string, unknown>
  created_at: string
}

const TIPO_LABEL: Record<Tipo, string> = { gasto: "Gastos", venta: "Ventas", abono: "Abonos" }
const TIPO_ICON: Record<Tipo, typeof Wallet> = { gasto: Wallet, venta: ShoppingBag, abono: HandCoins }

function formatMonto(n: number): string {
  return `$${n.toLocaleString("es-CO")}`
}

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

/** Dias que lleva esperando una solicitud. */
function diasEsperando(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

export function MovimientosRevision() {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<Tipo>("gasto")
  const [items, setItems] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<Solicitud | null>(null)
  const [motivo, setMotivo] = useState("")
  // La cola es de TODAS las rutas a proposito: secretaria atiende varias y
  // filtrarla a la ruta seleccionada le escondería el resto sin avisarle.
  // Lo que faltaba era ver de que ruta es cada movimiento antes de aprobarlo,
  // y poder acotar la vista cuando quiera.
  const [rutas, setRutas] = useState<Map<number, string>>(new Map())
  const [rutaFiltro, setRutaFiltro] = useState<number | "todas">("todas")
  // Seleccion para aprobar en lote. Aprobar veinte gastos de alimentacion
  // uno por uno era el trabajo diario de secretaria.
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set())
  const [aprobandoLote, setAprobandoLote] = useState(false)

  const fetchPending = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const [{ data, error }, { data: rutasData }] = await Promise.all([
        supabase
          .from("solicitudes_revision")
          .select("*")
          .eq("estado", "pendiente")
          .order("created_at", { ascending: true }),
        supabase.from("rutas").select("id, nombre").order("id"),
      ])
      if (error) throw error
      setItems((data ?? []) as Solicitud[])
      setRutas(new Map(((rutasData ?? []) as { id: number; nombre: string }[]).map((r) => [r.id, r.nombre])))
    } catch (err) {
      console.error("[v0] Error cargando solicitudes de revision:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchPending() }, [fetchPending])

  /**
   * Aplica UNA solicitud. Lanza si algo falla, para que quien la llama decida
   * si avisa o si sigue con la siguiente (aprobacion en lote).
   */
  const aprobarUna = async (s: Solicitud) => {
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

  const quitarDeLaLista = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id))
    setSeleccion((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const handleAprobar = async (s: Solicitud) => {
    setActionLoadingId(s.id)
    try {
      await aprobarUna(s)
      quitarDeLaLista(s.id)
      toast({ title: "Movimiento aprobado" })
    } catch (err) {
      console.error("[v0] Error aprobando solicitud:", err)
      toast({
        title: "Error al aprobar",
        description: err instanceof Error ? err.message : "No se pudo aprobar el movimiento",
        variant: "destructive",
      })
    } finally {
      setActionLoadingId(null)
    }
  }

  /**
   * Aprueba lo seleccionado, UNO A UNO y en serie.
   *
   * En serie a proposito: cada aprobacion escribe en loans/payment_plan o en
   * gastosregistros, y lanzarlas en paralelo multiplicaria las carreras que
   * justamente acabamos de cerrar. Si una falla, se sigue con las demas y al
   * final se informa cuantas quedaron.
   */
  const handleAprobarLote = async () => {
    const aAprobar = filtered.filter((i) => seleccion.has(i.id))
    if (aAprobar.length === 0) return
    setAprobandoLote(true)
    let ok = 0
    const fallidas: string[] = []
    for (const s of aAprobar) {
      setActionLoadingId(s.id)
      try {
        await aprobarUna(s)
        quitarDeLaLista(s.id)
        ok += 1
      } catch (err) {
        console.error("[v0] Error aprobando en lote:", s.id, err)
        fallidas.push(s.descripcion ?? s.id)
      }
    }
    setActionLoadingId(null)
    setAprobandoLote(false)
    toast({
      title: `${ok} de ${aAprobar.length} aprobados`,
      description: fallidas.length > 0 ? `No se pudieron aprobar: ${fallidas.join(", ")}` : undefined,
      variant: fallidas.length > 0 ? "destructive" : undefined,
    })
  }

  const handleRechazar = async () => {
    if (!rejectTarget) return
    setActionLoadingId(rejectTarget.id)
    try {
      if (rejectTarget.tipo === "gasto") {
        const identity = getSessionIdentity()
        const { error } = await createClient()
          .from("solicitudes_revision")
          .update({
            estado: "rechazado",
            revisado_por: identity.user_id,
            revisado_at: new Date().toISOString(),
            motivo_rechazo: motivo || null,
          })
          .eq("id", rejectTarget.id)
        if (error) throw error
      } else {
        await callRpcAtomic("aprobar_solicitud_revision", {
          solicitud_id: rejectTarget.id,
          decision: "rechazado",
          motivo_rechazo: motivo || null,
        })
      }
      quitarDeLaLista(rejectTarget.id)
      toast({ title: "Movimiento rechazado" })
    } catch (err) {
      console.error("[v0] Error rechazando solicitud:", err)
      toast({
        title: "Error al rechazar",
        description: err instanceof Error ? err.message : "No se pudo rechazar el movimiento",
        variant: "destructive",
      })
    } finally {
      setActionLoadingId(null)
      setRejectTarget(null)
      setMotivo("")
    }
  }

  const visibles = rutaFiltro === "todas" ? items : items.filter((i) => i.ruta_id === rutaFiltro)
  const counts = {
    gasto: visibles.filter((i) => i.tipo === "gasto").length,
    venta: visibles.filter((i) => i.tipo === "venta").length,
    abono: visibles.filter((i) => i.tipo === "abono").length,
  }
  const filtered = visibles.filter((i) => i.tipo === activeTab)
  const rutasEnCola = Array.from(new Set(items.map((i) => i.ruta_id))).sort((a, b) => a - b)
  const nombreRuta = (id: number) => rutas.get(id) ?? `Ruta ${id}`

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-border overflow-hidden p-0.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
        </div>
        <div>
          <h2 className="text-base md:text-lg font-bold leading-tight">Movimientos en Revisión</h2>
          <p className="text-[11px] text-muted-foreground">Gastos, ventas y abonos que superaron el umbral de su ruta</p>
        </div>
      </div>

      {/* Aviso de antiguedad: sin esto los movimientos se quedaban meses en
          la cola sin que nada lo gritara. */}
      {(() => {
        const masViejo = items.reduce<number>((max, i) => Math.max(max, diasEsperando(i.created_at)), 0)
        if (items.length === 0 || masViejo < 3) return null
        return (
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
            masViejo >= 15 ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"
          }`}>
            <Clock className="h-4 w-4 shrink-0" />
            <span>
              Hay <strong>{items.length}</strong> movimiento{items.length !== 1 ? "s" : ""} esperando.
              El más antiguo lleva <strong>{masViejo} días</strong> sin resolverse.
            </span>
          </div>
        )
      })()}

      {rutasEnCola.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-muted-foreground mr-1">Ruta:</span>
          <button
            type="button"
            onClick={() => setRutaFiltro("todas")}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              rutaFiltro === "todas" ? "border-brand bg-brand/10 font-semibold" : "hover:bg-muted/50"
            }`}
          >
            Todas ({items.length})
          </button>
          {rutasEnCola.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setRutaFiltro(id)}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                rutaFiltro === id ? "border-brand bg-brand/10 font-semibold" : "hover:bg-muted/50"
              }`}
            >
              {nombreRuta(id)} ({items.filter((i) => i.ruta_id === id).length})
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
              <p className="text-sm">Sin movimientos pendientes de revisión</p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Aprobacion en lote */}
              <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-current"
                    checked={filtered.length > 0 && filtered.every((i) => seleccion.has(i.id))}
                    onChange={(e) => {
                      const marcar = e.target.checked
                      setSeleccion((prev) => {
                        const next = new Set(prev)
                        filtered.forEach((i) => (marcar ? next.add(i.id) : next.delete(i.id)))
                        return next
                      })
                    }}
                  />
                  Seleccionar todo ({filtered.length})
                </label>
                {filtered.some((i) => seleccion.has(i.id)) && (
                  <Button
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    disabled={aprobandoLote}
                    onClick={handleAprobarLote}
                  >
                    {aprobandoLote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    Aprobar {filtered.filter((i) => seleccion.has(i.id)).length}
                  </Button>
                )}
              </div>

              {filtered.map((s) => {
                const Icon = TIPO_ICON[s.tipo]
                const busy = actionLoadingId === s.id
                return (
                  <div key={s.id} className="rounded-xl border bg-card p-3 md:p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <input
                          type="checkbox"
                          className="mt-3 h-3.5 w-3.5 shrink-0 accent-current"
                          checked={seleccion.has(s.id)}
                          disabled={busy || aprobandoLote}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const marcar = e.target.checked
                            setSeleccion((prev) => {
                              const next = new Set(prev)
                              if (marcar) next.add(s.id); else next.delete(s.id)
                              return next
                            })
                          }}
                        />
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-sm font-semibold truncate">{s.descripcion ?? TIPO_LABEL[s.tipo]}</p>
                            {s.subtipo && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {s.subtipo === "nueva" ? "Nueva" : "Renovación"}
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {nombreRuta(s.ruta_id)} · {s.solicitado_por_nombre ?? "—"} · {formatFecha(s.created_at)}
                            {diasEsperando(s.created_at) >= 3 && (
                              <span className={`ml-1 font-semibold ${diasEsperando(s.created_at) >= 15 ? "text-red-600" : "text-amber-600"}`}>
                                · {diasEsperando(s.created_at)} días esperando
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                      <p className="text-sm font-bold text-brand shrink-0">{formatMonto(s.monto)}</p>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => { setRejectTarget(s); setMotivo("") }}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Rechazar
                      </Button>
                      <Button
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        disabled={busy}
                        onClick={() => handleAprobar(s)}
                      >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                        Aprobar
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Dialog motivo de rechazo */}
      <Dialog open={!!rejectTarget} onOpenChange={(open) => { if (!open) { setRejectTarget(null); setMotivo("") } }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Rechazar movimiento</DialogTitle>
            <DialogDescription>
              {rejectTarget?.descripcion} — {rejectTarget ? formatMonto(rejectTarget.monto) : ""}
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
              disabled={actionLoadingId === rejectTarget?.id}
            >
              {actionLoadingId === rejectTarget?.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Rechazar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
