"use client"

/**
 * Diálogo para corregir un movimiento de caja.
 *
 * Lo comparten Ver Gastos (el asesor corrige lo suyo del día) y Control Total
 * (secretaría corrige cualquiera). El permiso NO se decide acá: quien abre el
 * diálogo ya resolvió si puede. Acá solo se decide qué se manda al servidor,
 * y el servidor vuelve a validar — una pantalla vieja no puede colarse.
 */

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ConceptoCombobox } from "@/components/concepto-combobox"
import { Loader2, Save, AlertTriangle } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { useToast } from "@/hooks/use-toast"
import { editTransaction } from "@/lib/actions/edit-transaction"
import { fmtMoneda, fmtFechaHora } from "@/lib/gestion-core"
import { todayColombia } from "@/lib/colombia-date"
import {
  getUsuarioSesion, movimientoAbierto, TABLA_CATALOGO, conceptosElegiblesAMano,
  type Movimiento,
} from "@/lib/movimientos"

interface Props {
  movimiento: Movimiento | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * true = lo edita el asesor: el servidor exige que sea suyo, de hoy y sin
   * resolver. false = secretaría desde Control Total, sin restricciones.
   */
  comoAsesor: boolean
  onSaved: () => void
}

export function EditMovimientoDialog({ movimiento, open, onOpenChange, comoAsesor, onSaved }: Props) {
  const { toast } = useToast()
  const [conceptos, setConceptos] = useState<string[]>([])
  const [fConcepto, setFConcepto] = useState("")
  const [fValor, setFValor] = useState("")
  const [fObservacion, setFObservacion] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!movimiento) return
    setFConcepto(movimiento.concepto ?? "")
    setFValor(String(movimiento.valor ?? ""))
    setFObservacion(movimiento.observacion ?? "")

    // El concepto se elige del mismo catálogo que al registrar, para no
    // terminar con dos textos distintos para el mismo concepto.
    const tabla = TABLA_CATALOGO[movimiento.tipo]
    if (!tabla) return
    let vigente = true
    ;(async () => {
      // `*` y no "nombre": hace falta `solo_sistema` para esconder los
      // conceptos que solo escribe el sistema, y pedirla por nombre reventaría
      // la consulta en `gastos` y `retiros`, que no la tienen.
      const { data, error } = await createClient().from(tabla).select("*").order("nombre")
      if (!vigente) return
      if (error) {
        console.error("[v0] No se pudo cargar el catálogo de conceptos:", error.message)
        return
      }
      const filas = (data ?? []) as unknown as { nombre: string; solo_sistema?: boolean | null }[]
      const nombres = conceptosElegiblesAMano(filas).map((x) => x.nombre)
      // El concepto actual puede no estar en el catálogo (item borrado, o
      // movimiento viejo). Se agrega para no perderlo al abrir el diálogo.
      if (movimiento.concepto && !nombres.includes(movimiento.concepto)) {
        nombres.unshift(movimiento.concepto)
      }
      setConceptos(nombres)
    })()
    return () => { vigente = false }
  }, [movimiento])

  if (!movimiento) return null

  const valorNum = Number.parseFloat(fValor)
  const cambioValor = Number.isFinite(valorNum) && valorNum !== Number(movimiento.valor)
  // Un movimiento 'NA' o ya aprobado YA está sumado en el Resumen del Día.
  // Cambiarle el valor mueve la caja de ese día hacia atrás, y quien edita
  // tiene que saberlo antes de guardar, no después de que no cuadre.
  const yaContabaEnCaja =
    movimiento.estadoadmin === "NA" || movimiento.estadosecre === "aprobado"

  const handleSave = async () => {
    if (!fConcepto.trim()) {
      toast({ title: "Falta el concepto", variant: "destructive" })
      return
    }
    if (!(valorNum > 0)) {
      toast({ title: "Valor inválido", description: "Tiene que ser mayor a cero.", variant: "destructive" })
      return
    }
    const usuario = getUsuarioSesion()
    if (!usuario.nombre) {
      toast({
        title: "Sesión sin identificar",
        description: "No se pudo saber quién está editando. Vuelve a iniciar sesión.",
        variant: "destructive",
      })
      return
    }

    setSaving(true)
    try {
      const res = await editTransaction({
        id: movimiento.id,
        concepto: fConcepto.trim(),
        valor: valorNum,
        observacion: fObservacion,
        editadoPor: usuario.nombre,
        restringirA: comoAsesor && usuario.id !== null
          ? { adminid: usuario.id, fechaColombia: todayColombia() }
          : undefined,
      })
      if (!res.success) {
        toast({ title: "No se pudo guardar", description: res.error, variant: "destructive" })
        return
      }
      toast({ title: "Movimiento actualizado" })
      onOpenChange(false)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Editar {movimiento.tipo.toLowerCase()}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-3 py-1 pr-1">
          <p className="text-[11px] text-muted-foreground">
            Registrado el {fmtFechaHora(movimiento.fechahorasol)} por {fmtMoneda(movimiento.valor)}.
          </p>

          {/* Secretaría puede editar movimientos ya resueltos; el aviso deja
              claro que se está pasando por encima de una firma. */}
          {!comoAsesor && !movimientoAbierto(movimiento) && (
            <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                Este movimiento ya fue resuelto
                {movimiento.adminaprobo ? ` por ${movimiento.adminaprobo}` : ""}. Editarlo no
                deshace esa firma — queda tu nombre como quien lo corrigió.
              </span>
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">Concepto</Label>
            <ConceptoCombobox
              opciones={conceptos.map((c) => ({ valor: c, etiqueta: c }))}
              valor={fConcepto}
              onValorChange={setFConcepto}
              placeholder="Elige un concepto"
              vacioTexto="No hay conceptos configurados"
              className="h-9 text-sm"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Valor</Label>
            <Input
              type="number"
              min="0"
              inputMode="decimal"
              value={fValor}
              onChange={(e) => setFValor(e.target.value)}
              className="h-9 text-sm"
            />
            {cambioValor && yaContabaEnCaja && (
              <p className="text-[11px] text-amber-700 dark:text-amber-300">
                Este movimiento ya está sumado en el Resumen del Día. Cambiar el valor
                mueve la caja de ese día.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Observación</Label>
            <Textarea
              value={fObservacion}
              onChange={(e) => setFObservacion(e.target.value)}
              rows={3}
              className="text-sm"
              placeholder="Opcional"
            />
          </div>

          {(movimiento.veces_editado ?? 0) > 0 && (
            <p className="text-[11px] text-muted-foreground border-t pt-2">
              Ya se editó {movimiento.veces_editado} {movimiento.veces_editado === 1 ? "vez" : "veces"}.
              La última, {movimiento.editado_por} el {fmtFechaHora(movimiento.fechahoraedicion)}
              {movimiento.valor_anterior !== null && ` (antes: ${fmtMoneda(movimiento.valor_anterior)})`}.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Guardar cambios
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
