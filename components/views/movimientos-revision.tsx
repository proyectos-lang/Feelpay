"use client"

import { useCallback, useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { callRpcAtomic, getSessionIdentity } from "@/lib/api-helper"
import { saveTransaction } from "@/lib/actions/save-transaction"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { Loader2, ShieldCheck, CheckCircle2, XCircle, Wallet, ShoppingBag, HandCoins } from "lucide-react"

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

export function MovimientosRevision() {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<Tipo>("gasto")
  const [items, setItems] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<Solicitud | null>(null)
  const [motivo, setMotivo] = useState("")

  const fetchPending = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await createClient()
        .from("solicitudes_revision")
        .select("*")
        .eq("estado", "pendiente")
        .order("created_at", { ascending: true })
      if (error) throw error
      setItems((data ?? []) as Solicitud[])
    } catch (err) {
      console.error("[v0] Error cargando solicitudes de revision:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchPending() }, [fetchPending])

  const handleAprobar = async (s: Solicitud) => {
    setActionLoadingId(s.id)
    try {
      if (s.tipo === "gasto") {
        // Camino asimetrico: gasto se aplica llamando saveTransaction()
        // (server action existente, sin cambios porque sube fotos a Vercel
        // Blob) y luego se marca la solicitud como resuelta con un UPDATE.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await saveTransaction(s.payload as any)
        if (!result.success) throw new Error(result.error ?? "No se pudo registrar el gasto")

        const identity = getSessionIdentity()
        const { error } = await createClient()
          .from("solicitudes_revision")
          .update({ estado: "aprobado", revisado_por: identity.user_id, revisado_at: new Date().toISOString() })
          .eq("id", s.id)
        if (error) throw error
      } else {
        // venta / abono: RPC atomica, cascada incluida (crea el prestamo +
        // plan de pagos, o aplica el abono, en una sola transaccion)
        await callRpcAtomic("aprobar_solicitud_revision", { solicitud_id: s.id, decision: "aprobado" })
      }
      setItems((prev) => prev.filter((i) => i.id !== s.id))
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
      setItems((prev) => prev.filter((i) => i.id !== rejectTarget.id))
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

  const counts = {
    gasto: items.filter((i) => i.tipo === "gasto").length,
    venta: items.filter((i) => i.tipo === "venta").length,
    abono: items.filter((i) => i.tipo === "abono").length,
  }
  const filtered = items.filter((i) => i.tipo === activeTab)

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
              {filtered.map((s) => {
                const Icon = TIPO_ICON[s.tipo]
                const busy = actionLoadingId === s.id
                return (
                  <div key={s.id} className="rounded-xl border bg-card p-3 md:p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
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
                            {s.solicitado_por_nombre ?? "—"} · {formatFecha(s.created_at)}
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
