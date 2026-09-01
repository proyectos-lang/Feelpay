/**
 * lib/loan-schedule.ts
 * ---------------------------------------------------------------------------
 * Cronograma de un préstamo — ESPEJO EXACTO de la función SQL
 * `generar_cronograma` (scripts/045-ventas-cronograma.sql).
 *
 * QUIÉN MANDA
 * El servidor. Este archivo NO genera el plan que se guarda: sirve para la
 * vista previa ("Simular amortización") y para la tabla de la venta
 * homologada. Si alguna vez difiere del SQL, gana el SQL.
 *
 * Existían TRES copias de esta matemática (dos dentro de new-loan.tsx y esta),
 * y divergían de verdad, no en detalles: esta usaba el algoritmo viejo de
 * domingos —correr la cuota un día sin mover las siguientes, con lo que la
 * cuota del domingo y la del lunes caían el mismo día— y además recibía la
 * tasa en decimal mientras quien la llamaba le pasaba puntos porcentuales,
 * así que editar una venta al 20% la recalculaba como si fuera 2000%.
 *
 * LAS REGLAS
 *   · Diario: se cobra de lunes a sábado. La cuota i cae en el i-ésimo día
 *     de cobro salteando domingos de corrido:
 *         fecha = inicio + (i−1) + floor((pos + i − 1) / 6)
 *     donde `pos` es la posición del día de inicio en la semana (lunes = 0).
 *   · Semanal con día de cobro: la primera cuota se corre al siguiente día
 *     de la semana elegido, y de ahí cada 7 días.
 *   · Semanal sin día / quincenal / mensual: +7 / +15 / +30 desde el inicio.
 *   · La cuota se redondea al MILLAR más cercano, con el 500 subiendo
 *     ($19.500 → $20.000, $19.499 → $19.000). Ver `redondearCuota`.
 *   · La ÚLTIMA cuota absorbe el residuo del redondeo, para que la suma del
 *     plan dé exactamente el total a pagar.
 */

import { todayColombia } from "@/lib/colombia-date"

export type Frecuencia = "daily" | "weekly" | "biweekly" | "monthly"
export type TipoAmortizacion = "americano" | "aleman" | "empleado"

export interface BuildScheduleParams {
  /** Capital prestado (sin intereses). */
  valor: number
  /**
   * Tasa de interés por período en PUNTOS PORCENTUALES (ej. 20 = 20%), la
   * misma unidad que se guarda en `loans.tasa_interes` y que muestra el
   * formulario. En préstamos de empleado se ignora.
   */
  tasaInteres: number
  /** Cantidad de cuotas. */
  numeroCuotas: number
  /** Frecuencia entre pagos. */
  frecuenciaPago: Frecuencia
  /** Tipo de amortización (con `prestamoEmpleado=true` se fuerza "empleado"). */
  tipoAmortizacion: TipoAmortizacion
  /** Préstamo de empleado: sin intereses, capital dividido en N cuotas diarias. */
  prestamoEmpleado: boolean
  /**
   * Fecha de la primera cuota, "YYYY-MM-DD". Si no se pasa se usa mañana
   * (regla de negocio: el plan arranca al día siguiente de la venta).
   */
  fechaInicio?: string
  /**
   * Día de cobro para frecuencia semanal ("lunes".."sabado"). Ancla la
   * primera cuota a ese día — antes se guardaba y se ignoraba, así que una
   * venta creada un martes con día "viernes" cobraba los martes.
   */
  diaSemana?: string | null
}

export interface PaymentScheduleRow {
  numero_cuota: number
  /** Vencimiento en formato YYYY-MM-DD. */
  fecha_pago: string
  valor_cuota: number
  capital: number
  interes: number
  /** Saldo pendiente DESPUÉS de aplicar esta cuota (solo informativo). */
  saldo: number
}

export interface ScheduleResult {
  schedule: PaymentScheduleRow[]
  /** Total a pagar (capital + intereses). */
  valorAPagar: number
  /** Cuota representativa. */
  valorCuota: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * La cuota, en números redondos. ESPEJO de `public.redondear_cuota`
 * (scripts/087-las-cuotas-en-numeros-redondos.sql).
 *
 * Al millar más cercano, y el 500 sube: $19.500 queda en $20.000 y $19.499 en
 * $19.000. Lo que se recorta o se agrega lo absorbe la última cuota, así que
 * la suma del plan sigue dando exactamente el total.
 *
 * DOS GUARDAS, las dos medidas contra los créditos reales antes de escribirlas:
 *
 * 1. POR DEBAJO DE MIL NO SE REDONDEA. La ruta 933 es de Ecuador y trabaja en
 *    dólares: sus cuotas van de $2 a $80, y al millar quedarían todas en cero.
 *    No hace falta configurar nada por país — una cuota de $6 no se redondea a
 *    millares en ninguna moneda.
 *
 * 2. LA ÚLTIMA NUNCA QUEDA EN CERO NI NEGATIVA. Subir la cuota le quita hasta
 *    $500 a cada una de las n−1 primeras, y eso puede pasarse de lo que vale
 *    la última. Caso real de la ruta 154: 20 cuotas sobre $150.000 dan $7.500,
 *    que sube a $8.000 — pero 8.000 × 19 = 152.000, más que el total. La cuota
 *    baja un escalón, a $7.000, y la última queda en $17.000.
 */
export function redondearCuota(base: number, total: number, cuotas: number): number {
  if (!Number.isFinite(base) || !Number.isFinite(total) || cuotas < 1) return base
  if (base < 1000) return round2(base)

  let r = Math.floor(base / 1000 + 0.5) * 1000
  while (r > 0 && total - r * (cuotas - 1) <= 0) r -= 1000
  return r > 0 ? r : round2(base)
}

// `domingo: 1` NO es un error: se manda a lunes. Los domingos no se cobra,
// asi que un credito semanal fechado en domingo dejaba TODAS sus cuotas en un
// dia en que nadie sale a la ruta. Espejo de `generar_cronograma` (script 067).
const DIAS_SEMANA: Record<string, number> = {
  domingo: 1, lunes: 1, martes: 2, miercoles: 3, "miércoles": 3,
  jueves: 4, viernes: 5, sabado: 6, "sábado": 6,
}

/** Suma días a una fecha "YYYY-MM-DD" sin cruzar zonas horarias. */
function sumar(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + dias)
  return dt.toISOString().slice(0, 10)
}

/** Día de la semana (0 = domingo) de una fecha "YYYY-MM-DD". */
function dow(fecha: string): number {
  const [y, m, d] = fecha.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Genera el cronograma. Espejo de `generar_cronograma` en SQL. */
export function buildPaymentSchedule(p: BuildScheduleParams): ScheduleResult {
  const { valor, numeroCuotas, prestamoEmpleado } = p
  const tasa = (p.tasaInteres || 0) / 100
  const tipo: TipoAmortizacion = prestamoEmpleado ? "empleado" : p.tipoAmortizacion
  const frecuencia: Frecuencia = prestamoEmpleado ? "daily" : p.frecuenciaPago

  if (!(valor > 0)) throw new Error("El valor del préstamo debe ser mayor que cero")
  if (!(numeroCuotas >= 1)) throw new Error("El número de cuotas debe ser al menos 1")

  // ── Fecha de inicio ────────────────────────────────────────────────────
  // NINGUNA cuota puede caer en domingo, en ninguna frecuencia. Antes esto
  // solo miraba la diaria, y un credito semanal/quincenal/mensual que
  // arrancara un domingo dejaba todas sus cuotas ahi: nacian vencidas y el
  // cliente aparecia en mora sin haber fallado nunca.
  let inicio = p.fechaInicio || sumar(todayColombia(), 1)
  if (dow(inicio) === 0) inicio = sumar(inicio, 1)
  if (frecuencia === "weekly" && p.diaSemana) {
    const objetivo = DIAS_SEMANA[p.diaSemana.toLowerCase()]
    if (objetivo !== undefined) {
      inicio = sumar(inicio, (((objetivo - dow(inicio)) % 7) + 7) % 7)
    }
  }

  const paso = frecuencia === "weekly" ? 7 : frecuencia === "biweekly" ? 15
    : frecuencia === "monthly" ? 30 : 1

  // ── Totales ────────────────────────────────────────────────────────────
  let valorAPagar: number
  let interesPorCuota = 0
  let cuotaBase = 0
  let capitalBase = 0

  if (tipo === "empleado") {
    valorAPagar = valor
    capitalBase = redondearCuota(valor / numeroCuotas, valor, numeroCuotas)
  } else if (tipo === "americano") {
    interesPorCuota = round2(valor * tasa)
    valorAPagar = valor + interesPorCuota * numeroCuotas
  } else {
    valorAPagar = round2(valor * (1 + tasa))
    cuotaBase = redondearCuota(valorAPagar / numeroCuotas, valorAPagar, numeroCuotas)
    capitalBase = round2(valor / numeroCuotas)
  }

  // lunes = 0 ... domingo = 6
  const pos = (dow(inicio) + 6) % 7

  const schedule: PaymentScheduleRow[] = []
  let acumulado = 0

  for (let i = 1; i <= numeroCuotas; i++) {
    // La diaria saltea domingos por construccion. Las demas avanzan de 7, 15
    // o 30 dias y si pueden aterrizar en domingo: esa cuota se corre al lunes
    // SIN mover las siguientes, para que el credito no se alargue un dia por
    // cada domingo que toque.
    let fecha_pago = paso === 1
      ? sumar(inicio, (i - 1) + Math.floor((pos + i - 1) / 6))
      : sumar(inicio, paso * (i - 1))
    if (paso !== 1 && dow(fecha_pago) === 0) fecha_pago = sumar(fecha_pago, 1)

    const esUltima = i === numeroCuotas
    let valor_cuota: number
    let capital: number
    let interes: number

    if (tipo === "empleado") {
      capital = esUltima ? round2(valor - capitalBase * (numeroCuotas - 1)) : capitalBase
      interes = 0
      valor_cuota = capital
    } else if (tipo === "americano") {
      valor_cuota = esUltima ? round2(valor + interesPorCuota) : interesPorCuota
      capital = esUltima ? valor : 0
      interes = interesPorCuota
    } else {
      valor_cuota = esUltima ? round2(valorAPagar - cuotaBase * (numeroCuotas - 1)) : cuotaBase
      capital = esUltima ? round2(valor - capitalBase * (numeroCuotas - 1)) : capitalBase
      interes = round2(valor_cuota - capital)
    }

    acumulado = round2(acumulado + valor_cuota)
    schedule.push({
      numero_cuota: i,
      fecha_pago,
      valor_cuota,
      capital,
      interes,
      saldo: round2(Math.max(0, valorAPagar - acumulado)),
    })
  }

  return {
    schedule,
    valorAPagar: round2(valorAPagar),
    valorCuota: schedule[0]?.valor_cuota ?? 0,
  }
}
