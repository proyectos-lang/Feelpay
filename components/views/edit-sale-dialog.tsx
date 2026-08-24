"use client"

/**
 * EditSaleDialog
 * --------------
 * Dialogo modal que permite editar una venta (loan) creada hoy.
 *
 * Flujo
 * -----
 * 1. El usuario abre el dialogo desde `<SalesTodayList>`.
 * 2. Se cargan los datos actuales del loan en el formulario.
 * 3. Al guardar se llama `editar_venta_atomica` (scripts/045): UNA
 *    transacción que regenera el cronograma con la misma función que crea
 *    las ventas.
 *
 * Qué pasa si la venta YA tiene pagos
 * -----------------------------------
 * El plan se regenera y los pagos NO se pierden: viven en el libro de
 * eventos, independiente del cronograma, y se reparten solos sobre las
 * cuotas nuevas. Para un cobrador la RPC sigue bloqueando la edición de una
 * venta con gestiones; secretaría y admin pueden editarla siempre (ese es
 * el "control total" del módulo de secretaría).
 */

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { getSupabaseSafe, callRpcAtomic } from "@/lib/api-helper"
import type { Frecuencia, TipoAmortizacion } from "@/lib/loan-schedule"

interface EditSaleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Datos del loan a editar. */
  sale: {
    id: string
    valor: number
    valor_cuota: number
    numero_cuotas: number
    tipo_amortizacion: string | null
    frecuencia_pago: string | null
    tipo_venta: string | null
    clientName?: string
  } | null
  /** Callback que el padre invoca para refrescar el listado tras guardar. */
  onSaved?: () => void
}

export function EditSaleDialog({ open, onOpenChange, sale, onSaved }: EditSaleDialogProps) {
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)

  // Estado local del formulario. Se sincroniza con `sale` cada vez que
  // el dialogo se abre con un loan distinto.
  const [valor, setValor] = useState("")
  const [tasaInteres, setTasaInteres] = useState("")
  const [numeroCuotas, setNumeroCuotas] = useState("")
  const [frecuenciaPago, setFrecuenciaPago] = useState<Frecuencia>("daily")
  const [tipoAmortizacion, setTipoAmortizacion] = useState<TipoAmortizacion>("americano")
  // Dia de cobro: solo aplica cuando frecuenciaPago !== "daily".
  // Se persiste en `loans.dia_semana` y se usa para calcular la
  // fecha inicial del cronograma (primer dia de la semana/mes que
  // coincida con el dia seleccionado, a partir de hoy+1).
  const [diaSemana, setDiaSemana] = useState("")

  // Para conocer la tasa actual del loan necesitamos consultarla; el row
  // del listado no la trae. Lo hacemos en un fetch inline al abrir.
  useEffect(() => {
    if (!open || !sale) return
    let cancelled = false
    ;(async () => {
      try {
        const supabase = await getSupabaseSafe()
        const { data, error } = await supabase
          .from("loans")
          .select("valor, tasa_interes, numero_cuotas, frecuencia_pago, tipo_amortizacion, prestamo_empleado, dia_semana")
          .eq("id", sale.id)
          .single()
        if (cancelled) return
        if (error || !data) {
          // Fallback: datos de la fila del listado.
          setValor(String(sale.valor ?? ""))
          setTasaInteres("")
          setNumeroCuotas(String(sale.numero_cuotas ?? ""))
          setFrecuenciaPago((sale.frecuencia_pago as Frecuencia) || "daily")
          setTipoAmortizacion((sale.tipo_amortizacion as TipoAmortizacion) || "americano")
          setDiaSemana("")
          return
        }
        setValor(String(data.valor ?? ""))
        setTasaInteres(String(data.tasa_interes ?? ""))
        setNumeroCuotas(String(data.numero_cuotas ?? ""))
        setFrecuenciaPago((data.frecuencia_pago as Frecuencia) || "daily")
        setTipoAmortizacion(
          data.prestamo_empleado
            ? "empleado"
            : ((data.tipo_amortizacion as TipoAmortizacion) || "americano"),
        )
        setDiaSemana(data.dia_semana ?? "")
      } catch (e) {
        console.error("[v0] EditSaleDialog load error:", e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, sale])

  const handleSave = async () => {
    if (!sale) return
    const valorNum = Number.parseFloat(valor)
    const tasaNum = Number.parseFloat(tasaInteres) || 0
    const cuotasNum = Number.parseInt(numeroCuotas)
    const prestamoEmpleado = tipoAmortizacion === "empleado"

    // Validaciones
    if (!valorNum || valorNum <= 0) {
      toast({ title: "Valor inválido", description: "Ingresa un valor mayor a 0.", variant: "destructive" })
      return
    }
    if (!cuotasNum || cuotasNum <= 0) {
      toast({ title: "Cuotas inválidas", description: "Ingresa un número de cuotas válido.", variant: "destructive" })
      return
    }
    if (!frecuenciaPago) {
      toast({ title: "Frecuencia requerida", description: "Selecciona una frecuencia de pago.", variant: "destructive" })
      return
    }
    if (frecuenciaPago !== "daily" && !diaSemana) {
      toast({ title: "Día requerido", description: "Selecciona el día de cobro para frecuencias no diarias.", variant: "destructive" })
      return
    }
    if (!prestamoEmpleado && tasaNum <= 0) {
      toast({ title: "Interés requerido", description: "Ingresa una tasa de interés válida.", variant: "destructive" })
      return
    }

    setSaving(true)
    try {
      // TODO EN UNA TRANSACCIÓN, EN EL SERVIDOR.
      //
      // Antes esto eran cuatro viajes sueltos desde el navegador —borrar el
      // plan, actualizar el préstamo, insertar el plan nuevo y renumerar las
      // filas conservadas—: si fallaba a mitad, la venta quedaba sin plan.
      // Además recalculaba el cronograma con una copia de la fórmula que ya
      // había divergido de la real.
      //
      // Ahora `editar_venta_atomica` (script 045) regenera el plan con la
      // MISMA función que crea las ventas, y el libro de eventos no se toca:
      // los pagos que ya existían se reasignan solos sobre el plan nuevo.
      const r = await callRpcAtomic("editar_venta_atomica", {
        loan_id: sale.id,
        valor: valorNum,
        tasa_interes: prestamoEmpleado ? 0 : tasaNum,
        numero_cuotas: cuotasNum,
        frecuencia_pago: frecuenciaPago,
        tipo_amortizacion: prestamoEmpleado ? "empleado" : tipoAmortizacion,
        prestamo_empleado: prestamoEmpleado,
        dia_semana: frecuenciaPago !== "daily" ? (diaSemana || null) : null,
        idempotency_key: crypto.randomUUID(),
      })

      const saldo = Number(r.nuevo_saldo ?? 0)
      toast({
        title: "Venta actualizada",
        description: `Plan regenerado con ${cuotasNum} cuota${cuotasNum === 1 ? "" : "s"}. Saldo: $${saldo.toLocaleString()}.`,
      })
      onSaved?.()
      onOpenChange(false)
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : (e as { message?: string })?.message ?? String(e)
      console.error("[v0] EditSaleDialog save error:", e)
      toast({
        title: "Error al actualizar la venta",
        description: msg,
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  const isEmpleado = tipoAmortizacion === "empleado"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar venta</DialogTitle>
          <DialogDescription>
            {sale?.clientName
              ? `Modifica los parámetros de la venta de ${sale.clientName}. El plan de pagos se regenerará.`
              : "Modifica los parámetros de la venta. El plan de pagos se regenerará."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-valor" className="text-xs">Valor del préstamo</Label>
            <Input
              id="edit-valor"
              type="number"
              step="0.01"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              className="h-9"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="edit-tipo" className="text-xs">Método de interés</Label>
            <Select value={tipoAmortizacion} onValueChange={(v) => setTipoAmortizacion(v as TipoAmortizacion)}>
              <SelectTrigger id="edit-tipo" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="americano">Cuota interés</SelectItem>
                <SelectItem value="aleman">Cuota fija</SelectItem>
                <SelectItem value="empleado">Empleado (sin intereses)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {!isEmpleado && (
            <div className="grid gap-1.5">
              <Label htmlFor="edit-tasa" className="text-xs">Tasa de interés (decimal: 0.20 = 20%)</Label>
              <Input
                id="edit-tasa"
                type="number"
                step="0.01"
                value={tasaInteres}
                onChange={(e) => setTasaInteres(e.target.value)}
                className="h-9"
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="edit-cuotas" className="text-xs">Número de cuotas</Label>
            <Input
              id="edit-cuotas"
              type="number"
              value={numeroCuotas}
              onChange={(e) => setNumeroCuotas(e.target.value)}
              className="h-9"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="edit-frecuencia" className="text-xs">Frecuencia de pago</Label>
            <Select
              value={frecuenciaPago}
              onValueChange={(v) => {
                setFrecuenciaPago(v as Frecuencia)
                // Limpiar dia al cambiar a diario — ya no aplica.
                if (v === "daily") setDiaSemana("")
              }}
            >
              <SelectTrigger id="edit-frecuencia" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Diario</SelectItem>
                <SelectItem value="weekly">Semanal</SelectItem>
                <SelectItem value="biweekly">Quincenal</SelectItem>
                <SelectItem value="monthly">Mensual</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Dia de cobro: visible solo cuando la frecuencia no es diaria.
              Se usa para anclar la fechaInicio del cronograma al dia
              correcto de la semana/mes. */}
          {frecuenciaPago !== "daily" && (
            <div className="grid gap-1.5">
              <Label htmlFor="edit-dia" className="text-xs">
                Día de cobro <span className="text-red-500">*</span>
              </Label>
              <Select value={diaSemana} onValueChange={setDiaSemana}>
                <SelectTrigger id="edit-dia" className="h-9">
                  <SelectValue placeholder="Selecciona el día" />
                </SelectTrigger>
                <SelectContent>
                  {/* Domingo NO se ofrece: no se cobra ese dia (script 067), y
                      elegirlo dejaba todas las cuotas en un dia sin ruta. */}
                  <SelectItem value="lunes">Lunes</SelectItem>
                  <SelectItem value="martes">Martes</SelectItem>
                  <SelectItem value="miercoles">Miércoles</SelectItem>
                  <SelectItem value="jueves">Jueves</SelectItem>
                  <SelectItem value="viernes">Viernes</SelectItem>
                  <SelectItem value="sabado">Sábado</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Guardando...
              </>
            ) : (
              "Guardar cambios"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
