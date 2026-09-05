"use client"

import { useCallback, useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { getSessionIdentity } from "@/lib/api-helper"
import { getSolicitanteNombre } from "@/lib/ruta-umbrales"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { Loader2, AlertTriangle, XCircle, CheckCircle2, Settings2, Save } from "lucide-react"
import { mostrarMonto, leerMonto } from "@/lib/gestion-core"

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

type MultaConfigRow = {
  ruta_id: number
  multa_habilitada: boolean
  multa_cuotas_umbral: number | null
  multa_tipo_valor: "fijo" | "cuotas"
  multa_valor: number | null
  multa_cantidad_cuotas: number | null
  logo_url: string | null
}

function formatMonto(n: number): string {
  return `$${n.toLocaleString("es-CO")}`
}

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

// ─── Tab Configuración: política de multas por ruta ────────────────────────

function ConfiguracionMultasTab() {
  const { toast } = useToast()
  const [rutas, setRutas] = useState<RutaOption[]>([])
  const [configs, setConfigs] = useState<Map<number, MultaConfigRow>>(new Map())
  const [selectedRutaId, setSelectedRutaId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [fHabilitada, setFHabilitada] = useState(false)
  const [fCuotas, setFCuotas] = useState("")
  const [fTipoValor, setFTipoValor] = useState<"fijo" | "cuotas">("fijo")
  const [fValor, setFValor] = useState("")
  const [fCantidadCuotas, setFCantidadCuotas] = useState("")
  const [fLogoUrl, setFLogoUrl] = useState("")

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const [{ data: rutasData }, { data: configsData }] = await Promise.all([
        supabase.from("rutas").select("id, nombre").order("id"),
        supabase.from("ruta_config_umbrales").select("ruta_id, multa_habilitada, multa_cuotas_umbral, multa_tipo_valor, multa_valor, multa_cantidad_cuotas, logo_url"),
      ])
      setRutas((rutasData as RutaOption[]) ?? [])
      setConfigs(new Map(((configsData as MultaConfigRow[]) ?? []).map((c) => [c.ruta_id, c])))
    } catch (err) {
      console.error("[v0] Error cargando configuración de multas:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const selectRuta = (id: number) => {
    setSelectedRutaId(id)
    const c = configs.get(id)
    setFHabilitada(c?.multa_habilitada ?? false)
    setFCuotas(c?.multa_cuotas_umbral?.toString() ?? "")
    setFTipoValor(c?.multa_tipo_valor ?? "fijo")
    setFValor(c?.multa_valor?.toString() ?? "")
    setFCantidadCuotas(c?.multa_cantidad_cuotas?.toString() ?? "")
    setFLogoUrl(c?.logo_url ?? "")
  }

  const handleGuardar = async () => {
    if (selectedRutaId === null) return
    setSaving(true)
    try {
      const payload = {
        ruta_id: selectedRutaId,
        multa_habilitada: fHabilitada,
        multa_cuotas_umbral: fCuotas ? Number.parseInt(fCuotas, 10) : null,
        multa_tipo_valor: fTipoValor,
        multa_valor: fTipoValor === "fijo" && fValor ? Number.parseFloat(fValor) : null,
        multa_cantidad_cuotas: fTipoValor === "cuotas" && fCantidadCuotas ? Number.parseFloat(fCantidadCuotas) : null,
        logo_url: fLogoUrl.trim() || null,
        updated_at: new Date().toISOString(),
      }
      const { error } = await createClient().from("ruta_config_umbrales").upsert(payload, { onConflict: "ruta_id" })
      if (error) throw error
      setConfigs((prev) => new Map(prev).set(selectedRutaId, payload))
      toast({ title: "Política de multas guardada" })
    } catch (err) {
      console.error("[v0] Error guardando configuración de multas:", err)
      toast({ title: "Error", description: err instanceof Error ? err.message : "No se pudo guardar", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const selectedRuta = rutas.find((r) => r.id === selectedRutaId)

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
      {/* Panel selector de ruta */}
      <div className="space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-1 mb-2">Rutas</p>
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
            {rutas.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => selectRuta(r.id)}
                className={`w-full text-left rounded-lg border px-3 py-2 text-sm transition-all truncate ${
                  selectedRutaId === r.id
                    ? "border-brand bg-brand/10 font-semibold"
                    : "border-transparent hover:border-border hover:bg-muted/50"
                }`}
              >
                {r.nombre}
              </button>
            ))}
            {rutas.length === 0 && <p className="text-xs text-muted-foreground px-1 py-2">Sin rutas registradas</p>}
          </div>
        )}
      </div>

      {/* Panel de configuración */}
      <div className="rounded-xl border bg-card p-4 space-y-4">
        {!selectedRuta ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-2">
            <Settings2 className="h-8 w-8 opacity-30" />
            <p className="text-sm">Selecciona una ruta para configurar<br />su política de multas</p>
          </div>
        ) : (
          <>
            <div>
              <p className="font-semibold text-sm">Política de multas por fallas</p>
              <p className="text-xs text-muted-foreground">{selectedRuta.nombre}</p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Generar multas automáticamente</Label>
                <Switch checked={fHabilitada} onCheckedChange={setFHabilitada} />
              </div>
              <Input
                type="number"
                min={1}
                step={1}
                disabled={!fHabilitada}
                value={fCuotas}
                onChange={(e) => setFCuotas(e.target.value)}
                placeholder="Cantidad de fallas para generar multa (ej. 3)"
                className="h-9 text-sm"
              />

              <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
                <button
                  type="button"
                  disabled={!fHabilitada}
                  onClick={() => setFTipoValor("fijo")}
                  className={`flex-1 h-8 rounded-md text-xs font-semibold transition-colors disabled:opacity-50 ${
                    fTipoValor === "fijo" ? "bg-brand text-white" : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  Valor fijo ($)
                </button>
                <button
                  type="button"
                  disabled={!fHabilitada}
                  onClick={() => setFTipoValor("cuotas")}
                  className={`flex-1 h-8 rounded-md text-xs font-semibold transition-colors disabled:opacity-50 ${
                    fTipoValor === "cuotas" ? "bg-brand text-white" : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  Cantidad de cuotas
                </button>
              </div>

              {fTipoValor === "fijo" ? (
                <Input
                  type="text"
                  inputMode="decimal"
                  disabled={!fHabilitada}
                  value={mostrarMonto(fValor)}
                  onChange={(e) => setFValor(leerMonto(e.target.value))}
                  placeholder="Valor de la multa (ej. $ 10.000)"
                  className="h-9 text-sm"
                />
              ) : (
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  disabled={!fHabilitada}
                  value={fCantidadCuotas}
                  onChange={(e) => setFCantidadCuotas(e.target.value)}
                  placeholder="Cantidad de cuotas a cobrar (ej. 1)"
                  className="h-9 text-sm"
                />
              )}
              {fTipoValor === "cuotas" && (
                <p className="text-[11px] text-muted-foreground">
                  La multa valdrá esa cantidad de cuotas del préstamo (ej. 1 cuota = el valor de una cuota normal).
                </p>
              )}
            </div>

            {/* Logo de la ruta: se imprime en el recibo de pago. Vive aqui
                porque esta es la pantalla de configuración por ruta. */}
            <div className="space-y-1.5 pt-3 border-t">
              <Label className="text-sm">Logo de la ruta (opcional)</Label>
              <Input
                value={fLogoUrl}
                onChange={(e) => setFLogoUrl(e.target.value)}
                placeholder="https://... (dirección de la imagen)"
                className="h-9 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                Aparece en el recibo de pago de esta ruta. Si se deja vacío se usa el logo de la app.
              </p>
              {fLogoUrl.trim() && (
                <div className="flex items-center gap-2 pt-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={fLogoUrl}
                    alt="Vista previa del logo"
                    className="h-10 w-10 rounded object-contain ring-1 ring-border bg-white"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none" }}
                  />
                  <span className="text-[11px] text-muted-foreground">Vista previa</span>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={handleGuardar} disabled={saving} className="gap-1.5 h-8 text-xs">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Guardar
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function MultasView() {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<"vigentes" | "historial" | "configuracion">("vigentes")
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
          <p className="text-[11px] text-muted-foreground">Multas por fallas generadas automáticamente por ruta</p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "vigentes" | "historial" | "configuracion")}>
          <TabsList className="grid grid-cols-3 w-full max-w-sm">
            <TabsTrigger value="vigentes" className="text-xs md:text-sm">Vigentes ({vigentesFiltradas.length})</TabsTrigger>
            <TabsTrigger value="historial" className="text-xs md:text-sm">Historial</TabsTrigger>
            <TabsTrigger value="configuracion" className="gap-1 text-xs md:text-sm">
              <Settings2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Configuración</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {activeTab !== "configuracion" && (
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
        )}
      </div>

      {activeTab === "configuracion" ? (
        <ConfiguracionMultasTab />
      ) : loading ? (
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
                            {m.cuotas_mora != null && ` · ${m.cuotas_mora} falla${m.cuotas_mora !== 1 ? "s" : ""}`}
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
