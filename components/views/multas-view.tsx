"use client"

import { useCallback, useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { getSessionIdentity } from "@/lib/api-helper"
import { getSolicitanteNombre } from "@/lib/ruta-umbrales"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { Loader2, AlertTriangle, XCircle, CheckCircle2 } from "lucide-react"

interface Multa {
  id: string
  loan_id: string
  client_id: string
  ruta_id: number
  cliente_nombre: string | null
  valor: number
  cuotas_mora: number | null
  estado: "pendiente" | "pagada" | "cancelada"
  created_at: string
  pagada_at: string | null
  metodo_pago: string | null
  cancelada_at: string | null
  cancelada_por_nombre: string | null
  motivo_cancelacion: string | null
}

type RutaOption = { id: number; nombre: string }

function formatMonto(n: number): string {
  return `$${n.toLocaleString("es-CO")}`
}

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function MultasView() {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<"vigentes" | "historial">("vigentes")
  const [vigentes, setVigentes] = useState<Multa[]>([])
  const [historial, setHistorial] = useState<Multa[]>([])
  const [rutas, setRutas] = useState<RutaOption[]>([])
  const [rutaFilter, setRutaFilter] = useState<string>("todas")
  const [loading, setLoading] = useState(true)
  const [cancelTarget, setCancelTarget] = useState<Multa | null>(null)
  const [motivo, setMotivo] = useState("")
  const [cancelling, setCancelling] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const [{ data: rutasData }, { data: pendientes }, { data: resueltas }] = await Promise.all([
        supabase.from("rutas").select("id, nombre").order("id"),
        supabase
          .from("multas")
          .select("*")
          .eq("estado", "pendiente")
          .order("created_at", { ascending: false }),
        supabase
          .from("multas")
          .select("*")
          .in("estado", ["pagada", "cancelada"])
          .order("created_at", { ascending: false })
          .limit(100),
      ])
      setRutas((rutasData as RutaOption[]) ?? [])
      setVigentes((pendientes as Multa[]) ?? [])
      setHistorial((resueltas as Multa[]) ?? [])
    } catch (err) {
      console.error("[v0] Error cargando multas:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const rutaNombre = (id: number) => rutas.find((r) => r.id === id)?.nombre ?? `Ruta ${id}`

  const handleCancelar = async () => {
    if (!cancelTarget) return
    setCancelling(true)
    try {
      const identity = getSessionIdentity()
      const { error, count } = await createClient()
        .from("multas")
        .update({
          estado: "cancelada",
          cancelada_at: new Date().toISOString(),
          cancelada_por: identity.user_id,
          cancelada_por_nombre: getSolicitanteNombre(),
          motivo_cancelacion: motivo || null,
        }, { count: "exact" })
        .eq("id", cancelTarget.id)
        .eq("estado", "pendiente")
      if (error) throw error
      if ((count ?? 0) === 0) {
        toast({ title: "La multa ya fue procesada", description: "Fue pagada o cancelada por otra sesión.", variant: "destructive" })
      } else {
        setVigentes((prev) => prev.filter((m) => m.id !== cancelTarget.id))
        toast({ title: "Multa cancelada" })
      }
      fetchAll()
    } catch (err) {
      console.error("[v0] Error cancelando multa:", err)
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "No se pudo cancelar la multa",
        variant: "destructive",
      })
    } finally {
      setCancelling(false)
      setCancelTarget(null)
      setMotivo("")
    }
  }

  const filterByRuta = (list: Multa[]) =>
    rutaFilter === "todas" ? list : list.filter((m) => m.ruta_id === Number(rutaFilter))

  const vigentesFiltradas = filterByRuta(vigentes)
  const historialFiltrado = filterByRuta(historial)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-border overflow-hidden p-0.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
        </div>
        <div>
          <h2 className="text-base md:text-lg font-bold leading-tight">Multas</h2>
          <p className="text-[11px] text-muted-foreground">Multas por mora generadas automáticamente por ruta</p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "vigentes" | "historial")}>
          <TabsList className="grid grid-cols-2 w-full max-w-xs">
            <TabsTrigger value="vigentes" className="text-xs md:text-sm">Vigentes ({vigentesFiltradas.length})</TabsTrigger>
            <TabsTrigger value="historial" className="text-xs md:text-sm">Historial</TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={rutaFilter} onValueChange={setRutaFilter}>
          <SelectTrigger className="h-9 text-xs md:text-sm w-40">
            <SelectValue placeholder="Ruta" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todas" className="text-xs md:text-sm">Todas las rutas</SelectItem>
            {rutas.map((r) => (
              <SelectItem key={r.id} value={r.id.toString()} className="text-xs md:text-sm">{r.nombre}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {activeTab === "vigentes" && (
            vigentesFiltradas.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
                <AlertTriangle className="h-8 w-8 opacity-30" />
                <p className="text-sm">Sin multas vigentes</p>
              </div>
            ) : (
              <div className="space-y-2">
                {vigentesFiltradas.map((m) => (
                  <div key={m.id} className="rounded-xl border bg-card p-3 md:p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
                          <AlertTriangle className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{m.cliente_nombre ?? "Cliente"}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {rutaNombre(m.ruta_id)}
                            {m.cuotas_mora != null && ` · ${m.cuotas_mora} cuotas en mora`}
                            {` · ${formatFecha(m.created_at)}`}
                          </p>
                        </div>
                      </div>
                      <p className="text-sm font-bold text-red-600 shrink-0">{formatMonto(m.valor)}</p>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
                        onClick={() => { setCancelTarget(m); setMotivo("") }}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Cancelar multa
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {activeTab === "historial" && (
            historialFiltrado.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
                <AlertTriangle className="h-8 w-8 opacity-30" />
                <p className="text-sm">Sin multas en el historial</p>
              </div>
            ) : (
              <div className="space-y-2">
                {historialFiltrado.map((m) => (
                  <div key={m.id} className="rounded-xl border bg-card p-3 md:p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                          m.estado === "pagada" ? "bg-green-100 text-green-600" : "bg-muted text-muted-foreground"
                        }`}>
                          {m.estado === "pagada" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-sm font-semibold truncate">{m.cliente_nombre ?? "Cliente"}</p>
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 ${
                                m.estado === "pagada"
                                  ? "border-green-300 text-green-700"
                                  : "border-border text-muted-foreground"
                              }`}
                            >
                              {m.estado === "pagada" ? "Pagada" : "Cancelada"}
                            </Badge>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {rutaNombre(m.ruta_id)}
                            {m.estado === "pagada" && m.pagada_at && ` · Pagada el ${formatFecha(m.pagada_at)}`}
                            {m.estado === "pagada" && m.metodo_pago && ` (${m.metodo_pago})`}
                            {m.estado === "cancelada" && m.cancelada_at && ` · Cancelada el ${formatFecha(m.cancelada_at)}`}
                            {m.estado === "cancelada" && m.cancelada_por_nombre && ` por ${m.cancelada_por_nombre}`}
                          </p>
                          {m.motivo_cancelacion && (
                            <p className="text-[11px] text-muted-foreground italic mt-0.5">Motivo: {m.motivo_cancelacion}</p>
                          )}
                        </div>
                      </div>
                      <p className="text-sm font-bold shrink-0">{formatMonto(m.valor)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}

      {/* Dialog cancelar multa */}
      <Dialog open={!!cancelTarget} onOpenChange={(open) => { if (!open) { setCancelTarget(null); setMotivo("") } }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Cancelar multa</DialogTitle>
            <DialogDescription>
              {cancelTarget?.cliente_nombre} — {cancelTarget ? formatMonto(cancelTarget.valor) : ""}. La multa dejará de aparecer en el listado de pagos.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Motivo de la cancelación (opcional)"
            className="text-sm"
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => { setCancelTarget(null); setMotivo("") }}>
              Volver
            </Button>
            <Button size="sm" variant="destructive" onClick={handleCancelar} disabled={cancelling}>
              {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Cancelar multa"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
