"use client"

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Building2, Loader2, MapPin, Globe2, AlertCircle, RefreshCw } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

export type SelectedRuta = {
  id: number
  nombre: string
  ciudad: string | null
  pais: string | null
}

interface RouteSelectorProps {
  open: boolean
  onSelect: (ruta: SelectedRuta) => void
  userId?: number | string | null
  userRol?: string | null
  onClose?: () => void
}

// Roles that have access to multiple routes (filtered via usuario_rutas table)
const MULTI_ROUTE_ROLES = new Set(["admin", "administrador", "secretaria", "secretario"])

export function RouteSelector({ open, onSelect, userId, userRol, onClose }: RouteSelectorProps) {
  const [rutas, setRutas] = useState<SelectedRuta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectingId, setSelectingId] = useState<number | null>(null)

  const fetchRutas = async () => {
    try {
      setLoading(true)
      setError(null)
      const supabase = createClient()

      // Build the route list filtered by the user's permissions (usuario_rutas)
      // when we have a user id; otherwise fall back to all rutas (legacy behavior).
      let rutasData: SelectedRuta[] = []

      if (userId !== null && userId !== undefined && userId !== "") {
        // SELECT directo sobre `usuario_rutas` filtrado por usuario_id.
        // (RLS eliminado — el filtro por usuario es 100% por aplicacion.)
        const queryWithCiudad = supabase
          .from("usuario_rutas")
          .select("rutas:ruta_id(id, nombre, ciudad, pais)")
          .eq("usuario_id", userId)

        let { data, error: queryError } = await queryWithCiudad

        if (queryError && /ciudad/i.test(queryError.message)) {
          const fallback = await supabase
            .from("usuario_rutas")
            .select("rutas:ruta_id(id, nombre, pais)")
            .eq("usuario_id", userId)
          if (fallback.error) throw fallback.error
          data = fallback.data
          queryError = null
        }
        if (queryError) throw queryError

        rutasData = (data ?? [])
          .map((row: any) => {
            const r = row.rutas
            if (!r) return null
            return {
              id: r.id,
              nombre: r.nombre,
              ciudad: r.ciudad ?? null,
              pais: r.pais ?? null,
            } as SelectedRuta
          })
          .filter((r: SelectedRuta | null): r is SelectedRuta => r !== null)
          .sort((a, b) => a.id - b.id)

        console.log(`[v0] route-selector cargado: ${rutasData.length} rutas`)
      } else {
        // No user context — load every route (fallback, mostly for dev)
        let { data, error: queryError } = await supabase
          .from("rutas")
          .select("id, nombre, ciudad, pais")
          .order("id", { ascending: true })

        if (queryError && /ciudad/i.test(queryError.message)) {
          const fallback = await supabase
            .from("rutas")
            .select("id, nombre, pais")
            .order("id", { ascending: true })
          if (fallback.error) throw fallback.error
          data = (fallback.data ?? []).map((r: any) => ({ ...r, ciudad: null }))
          queryError = null
        }

        if (queryError) throw queryError
        rutasData = (data ?? []) as SelectedRuta[]
      }

      setRutas(rutasData)

      // Auto-select for sellers when only one route is available
      const rol = (userRol ?? "").toLowerCase()
      const isMultiRouteRole = MULTI_ROUTE_ROLES.has(rol)
      if (!isMultiRouteRole && rutasData.length === 1) {
        // Defer to next tick so loading state settles first
        setTimeout(() => onSelect(rutasData[0]), 0)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error al cargar las rutas"
      console.error("[v0] RouteSelector fetch error:", msg)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) fetchRutas()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId, userRol])

  const handleSelect = (ruta: SelectedRuta) => {
    setSelectingId(ruta.id)
    onSelect(ruta)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && onClose) onClose() }}>
      <DialogContent
        showCloseButton={!!onClose}
        onInteractOutside={(e) => { if (!onClose) e.preventDefault() }}
        onEscapeKeyDown={(e) => { if (!onClose) e.preventDefault() }}
        className="sm:max-w-2xl"
      >
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-card ring-1 ring-border overflow-hidden p-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/opad-logo.png" alt="OPAD APP" className="h-full w-full object-contain" />
          </div>
          <DialogTitle className="text-center text-xl font-bold">Selecciona tu ruta</DialogTitle>
          <DialogDescription className="text-center">
            Elige la ruta con la que vas a trabajar. Esta seleccion se mantendra durante toda tu sesion.
          </DialogDescription>
        </DialogHeader>

        {/* Loading */}
        {loading && (
          <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl bg-muted/40">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Cargando rutas...</p>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-6 text-center">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <p className="text-sm font-medium text-destructive">{error}</p>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={fetchRutas}>
              <RefreshCw className="h-3.5 w-3.5" />
              Reintentar
            </Button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && rutas.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-center">
            <MapPin className="h-7 w-7 text-muted-foreground" />
            <p className="text-sm font-medium text-muted-foreground">No tienes rutas asignadas</p>
            <p className="text-xs text-muted-foreground">
              Tu usuario no tiene rutas habilitadas. Solicita acceso al administrador para continuar.
            </p>
          </div>
        )}

        {/* Lista de rutas */}
        {!loading && !error && rutas.length > 0 && (
          <div className="grid max-h-[60vh] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
            {rutas.map((ruta) => {
              const isSelecting = selectingId === ruta.id
              return (
                <button
                  key={ruta.id}
                  type="button"
                  onClick={() => handleSelect(ruta)}
                  disabled={isSelecting}
                  className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-brand-light hover:bg-brand/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand transition-colors group-hover:bg-brand group-hover:text-brand-foreground">
                      <Building2 className="h-4.5 w-4.5" />
                    </div>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      Ruta #{ruta.id}
                    </span>
                  </div>

                  <div className="flex w-full flex-col gap-0.5">
                    <h3 className="text-base font-bold leading-tight text-foreground">
                      {ruta.nombre || `Ruta ${ruta.id}`}
                    </h3>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      {ruta.ciudad && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {ruta.ciudad}
                        </span>
                      )}
                      {ruta.pais && (
                        <span className="inline-flex items-center gap-1">
                          <Globe2 className="h-3 w-3" />
                          {ruta.pais}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-1 flex w-full items-center justify-end">
                    {isSelecting ? (
                      <Loader2 className="h-4 w-4 animate-spin text-brand" />
                    ) : (
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-brand opacity-0 transition-opacity group-hover:opacity-100">
                        Seleccionar
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
