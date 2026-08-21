"use client"

/**
 * Confirmar el borrado de un movimiento de caja.
 *
 * Lo comparten Ver Gastos (el asesor borra lo suyo del día) y Control Total
 * (secretaría borra cualquiera del día). El permiso NO se decide acá: quien
 * abre el diálogo ya lo resolvió, y el servidor lo vuelve a validar — una
 * pantalla vieja no puede colarse.
 *
 * Muestra el movimiento completo antes de borrar a propósito. Es plata que ya
 * entró en la caja del día, y el nombre del concepto solo no alcanza para
 * distinguir dos gastos parecidos de la misma jornada.
 */

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, Trash2, AlertTriangle } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { deleteTransaction } from "@/lib/actions/delete-transaction"
import { fmtMoneda, fmtFechaHora } from "@/lib/gestion-core"
import { todayColombia } from "@/lib/colombia-date"
import { getUsuarioSesion, type Movimiento } from "@/lib/movimientos"

interface Props {
  movimiento: Movimiento | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** true = lo borra el asesor y el servidor exige que sea suyo. */
  comoAsesor: boolean
  onDeleted: () => void
}

export function EliminarMovimientoDialog({ movimiento, open, onOpenChange, comoAsesor, onDeleted }: Props) {
  const { toast } = useToast()
  const [motivo, setMotivo] = useState("")
  const [borrando, setBorrando] = useState(false)

  useEffect(() => {
    if (open) setMotivo("")
  }, [open])

  const confirmar = async () => {
    if (!movimiento) return
    setBorrando(true)
    try {
      const sesion = getUsuarioSesion()
      const res = await deleteTransaction({
        id: movimiento.id,
        eliminadoPorId: sesion.id,
        eliminadoPorNombre: sesion.nombre || "—",
        motivo,
        fechaColombia: todayColombia(),
        // Secretaría no manda el dueño: supervisa la ruta completa.
        ...(comoAsesor && sesion.id !== null ? { soloDelUsuario: sesion.id } : {}),
      })
      if (!res.success) {
        toast({ title: "No se pudo eliminar", description: res.error, variant: "destructive" })
        return
      }
      toast({ title: "Movimiento eliminado" })
      onOpenChange(false)
      onDeleted()
    } catch (err) {
      console.error("[v0] EliminarMovimientoDialog:", err)
      toast({
        title: "No se pudo eliminar",
        description: err instanceof Error ? err.message : "Intenta de nuevo.",
        variant: "destructive",
      })
    } finally {
      setBorrando(false)
    }
  }

  if (!movimiento) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-4">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-base flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            Eliminar movimiento
          </DialogTitle>
          <DialogDescription className="text-xs">
            Esta plata ya está contada en la caja de hoy. Al eliminarla, la caja cambia.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">{movimiento.tipo}</span>
            <span className="font-bold tabular-nums">{fmtMoneda(movimiento.valor)}</span>
          </div>
          <p className="text-[13px]">{movimiento.concepto}</p>
          {movimiento.observacion && (
            <p className="text-[12px] text-muted-foreground break-words">{movimiento.observacion}</p>
          )}
          <p className="text-[11px] text-muted-foreground">{fmtFechaHora(movimiento.fechahorasol)}</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="motivoBorrado" className="text-xs">
            ¿Por qué se elimina? <span className="text-muted-foreground font-normal">(opcional)</span>
          </Label>
          <Textarea
            id="motivoBorrado"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Ej: se registró dos veces por error"
            className="min-h-[60px] text-sm"
          />
        </div>

        {/* Se dice que queda registrado, y es cierto: el servidor copia la
            fila entera antes de borrarla. Decirlo cambia el comportamiento —
            nadie borra "a ver qué pasa" cuando sabe que queda firmado. */}
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px text-warning" />
          Queda registrado quién lo eliminó y qué decía. No se puede deshacer desde la app.
        </p>

        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={borrando}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={() => void confirmar()} disabled={borrando}>
            {borrando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            <span className="ml-1.5">Eliminar</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
