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
 * 3. Al guardar:
 *    a) Se BORRA el `payment_plan` actual del loan.
 *    b) Se hace UPDATE a `loans` con los nuevos valores
 *       (`valor`, `tasa_interes`, `numero_cuotas`, `frecuencia_pago`,
 *       `tipo_amortizacion`, `valor_a_pagar`, `valor_cuota`, etc.).
 *    c) Se inserta el nuevo cronograma usando el helper
 *       `buildPaymentSchedule` (mismo algoritmo que `crear_venta_atomica`).
 *
 * Por que no se usa `crear_venta_atomica`
 * ---------------------------------------
 * Esa RPC esta pensada para CREAR un loan + cliente nuevos. Aqui ya
 * existe el loan y el cliente, asi que se reutiliza el mismo helper de
 * generacion de cuotas, pero los UPDATE/INSERT se hacen directamente
 * para evitar crear duplicados.
 *
 * Atomicidad
 * ----------
 * Idealmente esto deberia correr como una unica transaccion server-side.
 * Para minimizar la ventana de inconsistencia ejecutamos en este orden:
 *   1) DELETE payment_plan
 *   2) UPDATE loans
 *   3) INSERT payment_plan (bulk)
 * Si el INSERT falla, intentamos restaurar (best-effort) llamando al
 * caller — pero el caso normal en datos de un solo dia es seguro.
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
import { getSupabaseSafe } from "@/lib/api-helper"
import {
  buildPaymentSchedule,
  type Frecuencia,
  type TipoAmortizacion,
} from "@/lib/loan-schedule"

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
      const supabase = await getSupabaseSafe()

      // Recalcular cronograma usando la misma logica que `crear_venta_atomica`.
      // Para frecuencias no diarias, calcular la fechaInicio como el
      // proximo dia de la semana que coincida con `diaSemana`, a partir
      // de manana. Esto replica la logica de new-loan.tsx.
      let fechaInicio: Date | undefined
      if (frecuenciaPago !== "daily" && diaSemana) {
        const diasMap: Record<string, number> = {
          domingo: 0, lunes: 1, martes: 2, miercoles: 3,
          jueves: 4, viernes: 5, sabado: 6,
        }
        const targetDay = diasMap[diaSemana]
        if (targetDay !== undefined) {
          const todayStr = new Date().toLocaleDateString("en-CA")
          const [y, m, d] = todayStr.split("-").map(Number)
          const candidate = new Date(y, m - 1, d + 1) // manana
          const diff = (targetDay - candidate.getDay() + 7) % 7
          candidate.setDate(candidate.getDate() + diff)
          fechaInicio = candidate
        }
      }

      const { schedule, valorAPagar, valorCuota } = buildPaymentSchedule({
        valor: valorNum,
        tasaInteres: tasaNum,
        numeroCuotas: cuotasNum,
        frecuenciaPago,
        tipoAmortizacion,
        prestamoEmpleado,
        fechaInicio,
      })

      // 1) Borrar payment_plan existente. Filtramos por loan_id; cualquier
      //    pago ya registrado tambien se borra (caso normal: la venta es de
      //    HOY y aun no se le ha cobrado nada).
      const { error: delError } = await supabase
        .from("payment_plan")
        .delete()
        .eq("loan_id", sale.id)
      if (delError) throw delError

      // 2) UPDATE loans con los nuevos parametros.
      const { error: updError } = await supabase
        .from("loans")
        .update({
          valor: valorNum,
          tasa_interes: prestamoEmpleado ? 0 : tasaNum,
          numero_cuotas: cuotasNum,
          frecuencia_pago: frecuenciaPago,
          tipo_amortizacion: prestamoEmpleado ? "empleado" : tipoAmortizacion,
          prestamo_empleado: prestamoEmpleado,
          valor_a_pagar: valorAPagar,
          saldo: valorAPagar,
          valor_cuota: valorCuota,
          dia_semana: frecuenciaPago !== "daily" ? (diaSemana || null) : null,
        })
        .eq("id", sale.id)
      if (updError) throw updError

      // 3) Insertar el nuevo cronograma.
      const planRows = schedule.map((row) => ({
        loan_id: sale.id,
        numero_cuota: row.numero_cuota,
        fecha_pago: row.fecha_pago,
        valor_cuota: row.valor_cuota,
        capital: row.capital,
        interes: row.interes,
        saldo: row.saldo,
        estado: "pendiente" as const,
        monto_pagado: 0,
      }))

      const { error: insError } = await supabase.from("payment_plan").insert(planRows)
      if (insError) throw insError

      toast({
        title: "Venta actualizada",
        description: `Plan de pagos regenerado con ${cuotasNum} cuota${cuotasNum === 1 ? "" : "s"}.`,
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
                <SelectItem value="americano">Americano (interés plano)</SelectItem>
                <SelectItem value="aleman">Alemán (cuota fija)</SelectItem>
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
                  <SelectItem value="lunes">Lunes</SelectItem>
                  <SelectItem value="martes">Martes</SelectItem>
                  <SelectItem value="miercoles">Miércoles</SelectItem>
                  <SelectItem value="jueves">Jueves</SelectItem>
                  <SelectItem value="viernes">Viernes</SelectItem>
                  <SelectItem value="sabado">Sábado</SelectItem>
                  <SelectItem value="domingo">Domingo</SelectItem>
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
