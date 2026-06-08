/**
 * lib/dashboard-data.ts
 * ---------------------------------------------------------------------------
 * Capa de acceso a datos para el dashboard de pagos.
 *
 * CAMBIO ARQUITECTONICO (mayo 2026): RLS eliminado.
 * --------------------------------------------------
 * Antes esto intentaba primero `obtener_dashboard_pagos` (RPC atomica que
 * fijaba session vars dentro de la transaccion) con fallback a 4 SELECTs
 * paralelos + retries. Como RLS fue eliminado, ya no hay condicion de
 * carrera con PgBouncer: simplemente ejecutamos 4 SELECTs paralelos
 * filtrando por ruta con `.eq('ruta', rutaId)`. Sin retries, sin RPC.
 *
 * El shape de retorno se mantiene identico para no tocar `register-payment.tsx`.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export type LoanWithClient = {
  id: string
  client_id: string
  valor: number
  saldo: number
  valor_a_pagar: number
  valor_cuota: number
  tasa_interes: number
  numero_cuotas: number
  frecuencia_pago: string
  tipo_amortizacion: string
  estado: string
  ruta: number
  ordenvisita: number
  dia_semana: string | null
  created_at?: string
  fecha_creacion?: string
  fecha_primer_pago?: string
  prestamo_empleado?: boolean
  tipo_venta?: string
  enrutar_venta?: string | null
  clients: {
    nombre_completo: string
    apodo: string | null
    documento: string
  }
}

export type PaymentPlanEntry = {
  id: string
  loan_id: string
  numero_cuota: number
  fecha_pago: string
  valor_cuota: number
  capital: number
  interes: number
  saldo: number
  estado: string
  fecha_pago_real: string | null
  monto_pagado: number
  ruta?: number
}

export type DashboardPagosResult = {
  loans: LoanWithClient[]
  saldoMap: Map<string, number>
  moraMap: Map<string, number>
  /** Fecha del último pago registrado por loan_id (YYYY-MM-DD), según saldo_prestamos_clientes. */
  fechaUltimoPagoMap: Map<string, string>
  allPaymentPlans: PaymentPlanEntry[]
  /** Conservado por compatibilidad. Siempre "direct" tras eliminar RPC. */
  source: "direct"
}

/**
 * Carga el dashboard de pagos con 4 SELECTs paralelos filtrando por ruta.
 * Sin RLS, sin RPC, sin retries.
 */
export async function loadDashboardPagos(
  supabase: SupabaseClient,
  args: {
    rutaId: number
    userId?: number | string | null
    rol?: string | null
  },
): Promise<DashboardPagosResult> {
  // ── 1) Cargar loans filtrados por ruta ────────────────────────────
  const { data: loansData, error: loansError } = await supabase
    .from("loans")
    .select("*, clients(nombre_completo, apodo, documento)")
    .eq("ruta", args.rutaId)
    .order("ordenvisita", { ascending: true })

  if (loansError) {
    console.error("[v0] loans error:", loansError.message)
    throw new Error(`loans: ${loansError.message}`)
  }

  const loans = (loansData ?? []) as unknown as LoanWithClient[]
  const activeLoans = loans.filter(
    (l) => l.estado === "activo" || !l.estado,
  )
  const loanIds = activeLoans.map((l) => l.id)

  const saldoMap = new Map<string, number>()
  const moraMap = new Map<string, number>()
  const fechaUltimoPagoMap = new Map<string, string>()
  let allPaymentPlans: PaymentPlanEntry[] = []

  if (loanIds.length === 0) {
    return { loans: activeLoans, saldoMap, moraMap, fechaUltimoPagoMap, allPaymentPlans, source: "direct" }
  }

  // ── 2) Cargar saldos + mora + payment_plans en paralelo ───────────
  //
  // Estas vistas/tabla NO tienen columna `ruta` (saldo_prestamos_clientes y
  // v_loan_mora_status son vistas calculadas sobre loans, y payment_plan ya
  // se filtra por loan_id que pertenece a esta ruta). Por eso no aplica
  // `.eq('ruta', ...)` aqui — el filtro ya viene implicito al hacer
  // `.in('loan_id', loanIds)` con IDs de prestamos de la ruta actual.
  type SaldoRow = { loan_id: string; saldo_pendiente: number; fechaultimopago: string | null }
  type MoraRow = { loan_id: string; dias_mora_calculada: number }

  const [saldoRes, moraRes, ppRes] = await Promise.all([
    supabase
      .from("saldo_prestamos_clientes")
      .select("loan_id, saldo_pendiente, fechaultimopago")
      .in("loan_id", loanIds),
    supabase
      .from("v_loan_mora_status")
      .select("loan_id, dias_mora_calculada")
      .in("loan_id", loanIds),
    supabase
      .from("payment_plan")
      .select(
        "id, loan_id, numero_cuota, valor_cuota, capital, estado, fecha_pago, fecha_pago_real, monto_pagado",
      )
      .in("loan_id", loanIds)
      .order("numero_cuota", { ascending: true }),
  ])

  if (saldoRes.error) {
    console.error("[v0] saldo_prestamos_clientes error:", saldoRes.error.message)
  } else {
    for (const s of (saldoRes.data ?? []) as SaldoRow[]) {
      saldoMap.set(s.loan_id, s.saldo_pendiente)
      if (s.fechaultimopago) {
        // Normalize to YYYY-MM-DD in case it comes as a full timestamp
        fechaUltimoPagoMap.set(s.loan_id, s.fechaultimopago.split("T")[0])
      }
    }
  }

  if (moraRes.error) {
    console.error("[v0] v_loan_mora_status error:", moraRes.error.message)
  } else {
    for (const m of (moraRes.data ?? []) as MoraRow[]) {
      moraMap.set(m.loan_id, m.dias_mora_calculada ?? 0)
    }
  }

  if (ppRes.error) {
    console.error("[v0] payment_plan error:", ppRes.error.message)
  } else {
    allPaymentPlans = (ppRes.data ?? []) as unknown as PaymentPlanEntry[]
  }

  return { loans: activeLoans, saldoMap, moraMap, fechaUltimoPagoMap, allPaymentPlans, source: "direct" }
}
