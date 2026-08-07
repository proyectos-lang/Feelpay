"use client"

/**
 * Indicador de conexión y de operaciones pendientes de sincronizar.
 *
 * Vive en el header y es el único punto donde se monta `useOfflineSync`, así
 * que también es el motor que dispara la sincronización automática.
 */

import { useEffect, useState } from "react"
import { CloudOff, RefreshCw, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { useOfflineSync } from "@/lib/use-offline-sync"
import { listarCola, descartar, reintentar, type ItemCola } from "@/lib/offline-queue"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"

function formatFechaHora(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  })
}

export function OfflineIndicator() {
  const { toast } = useToast()
  const { online, pendientes, fallidos, sincronizando, ultimoResultado, limpiarResultado, sincronizar } =
    useOfflineSync()
  const [abierto, setAbierto] = useState(false)
  const [items, setItems] = useState<ItemCola[]>([])

  // Aviso al terminar de sincronizar
  useEffect(() => {
    if (!ultimoResultado) return
    const { sincronizados, enRevision, fallidos: fall } = ultimoResultado

    if (sincronizados > 0 && enRevision === 0 && fall === 0) {
      toast({
        title: "Sincronización completa",
        description: `${sincronizados} operación${sincronizados === 1 ? "" : "es"} se guardó${sincronizados === 1 ? "" : "n"} correctamente.`,
      })
    } else if (enRevision > 0 || fall > 0) {
      const partes: string[] = []
      if (sincronizados > 0) partes.push(`${sincronizados} sincronizada${sincronizados === 1 ? "" : "s"}`)
      if (enRevision > 0) partes.push(`${enRevision} en revisión de secretaría`)
      if (fall > 0) partes.push(`${fall} con error`)
      toast({
        title: fall > 0 ? "Sincronización con problemas" : "Sincronización completa",
        description: partes.join(", ") + ".",
        variant: fall > 0 ? "destructive" : undefined,
      })
    }
    limpiarResultado()
  }, [ultimoResultado, toast, limpiarResultado])

  const abrirDetalle = async () => {
    setItems(await listarCola())
    setAbierto(true)
  }

  const refrescarItems = async () => setItems(await listarCola())

  // Nada que mostrar: con conexión y sin pendientes
  if (online && pendientes === 0 && fallidos === 0) return null

  const total = pendientes + fallidos

  return (
    <>
      <button
        type="button"
        onClick={abrirDetalle}
        title={online ? "Operaciones pendientes de sincronizar" : "Sin conexión"}
        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${
          !online
            ? "border border-amber-400 bg-amber-50 text-amber-700"
            : fallidos > 0
              ? "border border-destructive/50 bg-destructive/10 text-destructive"
              : "border border-brand/40 bg-brand/10 text-brand"
        }`}
      >
        {sincronizando ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : !online ? (
          <CloudOff className="h-3 w-3" />
        ) : fallidos > 0 ? (
          <AlertTriangle className="h-3 w-3" />
        ) : (
          <RefreshCw className="h-3 w-3" />
        )}
        <span className="hidden sm:inline">{!online ? "Sin conexión" : "Por sincronizar"}</span>
        {total > 0 && <span className="tabular-nums">{total}</span>}
      </button>

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">
              {!online ? "Trabajando sin conexión" : "Operaciones por sincronizar"}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {!online
                ? "Lo que registres se guarda en el teléfono y se enviará solo cuando vuelva la señal."
                : "Estas operaciones aún no llegan al servidor. Se reintentan solas."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 max-h-72 overflow-y-auto">
            {items.length === 0 && (
              <div className="flex flex-col items-center gap-1.5 py-6 text-center text-muted-foreground">
                <CheckCircle2 className="h-7 w-7 opacity-40" />
                <p className="text-sm">Todo sincronizado</p>
              </div>
            )}
            {items.map((it) => (
              <div key={it.id} className="rounded-lg border p-2.5 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium min-w-0 truncate">{it.descripcion}</p>
                  <span
                    className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                      it.estado === "fallido"
                        ? "bg-destructive/10 text-destructive"
                        : it.estado === "enviando"
                          ? "bg-brand/10 text-brand"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {it.estado === "fallido" ? "Con error" : it.estado === "enviando" ? "Enviando" : "Pendiente"}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">{formatFechaHora(it.capturadoEn)}</p>
                {it.estado === "fallido" && (
                  <>
                    {it.ultimoError && (
                      <p className="text-[11px] text-destructive break-words">{it.ultimoError}</p>
                    )}
                    <div className="flex gap-1.5 pt-0.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[11px]"
                        onClick={async () => { await reintentar(it.id); await refrescarItems(); void sincronizar() }}
                      >
                        Reintentar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px] text-destructive hover:text-destructive"
                        onClick={async () => { await descartar(it.id); await refrescarItems() }}
                      >
                        Descartar
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          {online && items.length > 0 && (
            <Button
              size="sm"
              className="w-full gap-1.5"
              disabled={sincronizando}
              onClick={async () => { await sincronizar(); await refrescarItems() }}
            >
              {sincronizando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sincronizar ahora
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
