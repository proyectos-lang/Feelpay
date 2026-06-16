/**
 * lib/loan-schedule.ts
 * --------------------
 * Generador de plan de pagos. Contiene la MISMA logica de amortizacion
 * que utiliza `components/views/new-loan.tsx` antes de invocar la RPC
 * `crear_venta_atomica`. Se extrajo aqui para que el dialogo de edicion
 * de una venta (`edit-sale-dialog.tsx`) pueda reconstruir el cronograma
 * con los nuevos parametros sin duplicar codigo.
 *
 * IMPORTANTE — paridad con new-loan.tsx
 * -------------------------------------
 * Cualquier cambio en la formula de amortizacion debe replicarse en
 * ambos archivos hasta que migremos completamente a esta utilidad. La
 * regla "skip domingo" para frecuencia diaria se mantiene aqui.
 */

import { todayColombia } from "@/lib/colombia-date"

export type Frecuencia = "daily" | "weekly" | "biweekly" | "monthly"
export type TipoAmortizacion = "americano" | "aleman" | "empleado"

export interface BuildScheduleParams {
  /** Capital prestado (sin intereses). */
  valor: number
  /** Tasa de interes por periodo en decimal (ej. 0.20 = 20%). Para
   *  prestamos empleado se ignora. */
  tasaInteres: number
  /** Cantidad de cuotas. */
  numeroCuotas: number
  /** Frecuencia entre pagos. */
  frecuenciaPago: Frecuencia
  /** Tipo de amortizacion (con `prestamoEmpleado=true` se fuerza "empleado"). */
  tipoAmortizacion: TipoAmortizacion
  /** Si es prestamo empleado: sin intereses, capital dividido en N cuotas diarias. */
  prestamoEmpleado: boolean
  /**
   * Fecha base desde la cual generar el plan. Si no se pasa, se usa
   * "hoy + 1 dia" (regla de negocio: el plan inicia al dia siguiente).
   * Se interpreta SIEMPRE en zona local del navegador.
   */
  fechaInicio?: Date
}

export interface PaymentScheduleRow {
  numero_cuota: number
  /** Fecha en formato YYYY-MM-DD (hora local, sin UTC). */
  fecha_pago: string
  valor_cuota: number
  capital: number
  interes: number
  /** Saldo pendiente DESPUES de aplicar esta cuota. */
  saldo: number
}

export interface ScheduleResult {
  schedule: PaymentScheduleRow[]
  /** Total a pagar (capital + intereses) — se persiste en `loans.valor_a_pagar`/`saldo`. */
  valorAPagar: number
  /** Cuota representativa que se persiste en `loans.valor_cuota`. */
  valorCuota: number
}

// Formatea un Date a YYYY-MM-DD usando partes LOCALES — evita el bug
// clasico de `.toISOString().split("T")[0]` que convierte a UTC y puede
// restar un dia segun el huso del navegador.
const toLocalDateStr = (d: Date): string => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Genera el cronograma de pagos para una venta.
 * Replica exactamente el algoritmo de `new-loan.tsx`.
 */
export function buildPaymentSchedule(p: BuildScheduleParams): ScheduleResult {
  const { valor, tasaInteres, numeroCuotas, frecuenciaPago, tipoAmortizacion, prestamoEmpleado } = p

  // Total a pagar segun el tipo:
  // - Empleado: solo el capital
  // - Americano: capital + intereses planos por cada cuota
  // - Aleman: capital + interes total unico
  let valorAPagar: number
  if (prestamoEmpleado) {
    valorAPagar = valor
  } else if (tipoAmortizacion === "americano") {
    valorAPagar = valor + valor * tasaInteres * numeroCuotas
  } else {
    valorAPagar = valor + valor * tasaInteres
  }

  // Para americano la "cuota" tipica es solo el interes; para aleman es el promedio.
  const valorCuota =
    tipoAmortizacion === "americano" && !prestamoEmpleado
      ? valor * tasaInteres
      : valorAPagar / numeroCuotas

  // Dias entre pagos
  let diasEntrePagos = 1
  if (!prestamoEmpleado) {
    switch (frecuenciaPago) {
      case "weekly": diasEntrePagos = 7; break
      case "biweekly": diasEntrePagos = 15; break
      case "monthly": diasEntrePagos = 30; break
      default: diasEntrePagos = 1
    }
  }

  // Cobro diario no aplica a domingos: si la fecha calculada cae en
  // domingo, se corre al lunes. Solo aplica con diasEntrePagos === 1.
  const skipDomingoSiDiario = (d: Date): Date => {
    if (diasEntrePagos !== 1) return d
    if (d.getDay() === 0) {
      const ajustada = new Date(d)
      ajustada.setDate(ajustada.getDate() + 1)
      return ajustada
    }
    return d
  }

  // Fecha inicio: hoy+1 si no se especifica.
  let fechaInicio: Date
  if (p.fechaInicio) {
    fechaInicio = new Date(p.fechaInicio)
  } else {
    const todayStr = todayColombia()
    const [y, m, d] = todayStr.split("-").map(Number)
    fechaInicio = new Date(y, m - 1, d + 1)
  }
  fechaInicio = skipDomingoSiDiario(fechaInicio)

  const schedule: PaymentScheduleRow[] = []

  if (prestamoEmpleado) {
    const cuotaDiaria = round2(valor / numeroCuotas)
    for (let i = 1; i <= numeroCuotas; i++) {
      let fechaPago = new Date(fechaInicio)
      fechaPago.setDate(fechaPago.getDate() + (i - 1))
      fechaPago = skipDomingoSiDiario(fechaPago)
      schedule.push({
        numero_cuota: i,
        fecha_pago: toLocalDateStr(fechaPago),
        valor_cuota: cuotaDiaria,
        capital: cuotaDiaria,
        interes: 0,
        saldo: round2(Math.max(0, valor - cuotaDiaria * i)),
      })
    }
  } else if (tipoAmortizacion === "americano") {
    // Cada cuota paga interes; la ultima incluye ademas el capital completo.
    const interesPorCuota = round2(valor * tasaInteres)
    for (let i = 1; i <= numeroCuotas; i++) {
      let fechaPago = new Date(fechaInicio)
      fechaPago.setDate(fechaPago.getDate() + diasEntrePagos * (i - 1))
      fechaPago = skipDomingoSiDiario(fechaPago)
      const esUltima = i === numeroCuotas
      const capitalCuota = esUltima ? valor : 0
      const cuotaPago = interesPorCuota + capitalCuota
      const cuotasRestantesFinal = numeroCuotas - i
      const saldoRestante = esUltima ? 0 : valor + interesPorCuota * cuotasRestantesFinal
      schedule.push({
        numero_cuota: i,
        fecha_pago: toLocalDateStr(fechaPago),
        valor_cuota: round2(cuotaPago),
        capital: round2(capitalCuota),
        interes: interesPorCuota,
        saldo: round2(saldoRestante),
      })
    }
  } else {
    // Aleman simple: cuota fija = valorAPagar / numCuotas, interes/capital fijos.
    const saldoTotal = valor + valor * tasaInteres
    const cuotaFija = round2(saldoTotal / numeroCuotas)
    const interesPorCuota = round2((valor * tasaInteres) / numeroCuotas)
    const capitalPorCuota = round2(valor / numeroCuotas)
    for (let i = 1; i <= numeroCuotas; i++) {
      let fechaPago = new Date(fechaInicio)
      fechaPago.setDate(fechaPago.getDate() + diasEntrePagos * (i - 1))
      fechaPago = skipDomingoSiDiario(fechaPago)
      const saldoRestante = Math.max(0, saldoTotal - cuotaFija * i)
      schedule.push({
        numero_cuota: i,
        fecha_pago: toLocalDateStr(fechaPago),
        valor_cuota: cuotaFija,
        capital: capitalPorCuota,
        interes: interesPorCuota,
        saldo: round2(saldoRestante),
      })
    }
  }

  return {
    schedule,
    valorAPagar: round2(valorAPagar),
    valorCuota: round2(valorCuota),
  }
}
