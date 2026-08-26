/**
 * lib/dashboard-data.ts
 * ---------------------------------------------------------------------------
 * Capa de acceso a datos del módulo de pagos.
 *
 * NÚCLEO NUEVO (scripts 041-049)
 * ------------------------------
 * Antes esto leía dos vistas distintas para el dinero (`saldo_prestamos_clientes`
 * y `v_loan_mora_status`) que podían contradecirse, y la pantalla deducía a
 * mano, a partir de estados de cuota y horas, si un cliente ya estaba
 * gestionado hoy.
 *
 * Ahora:
 *   · `v_loan_financiero` — saldo, saldo de hoy, mora y conteo de cuotas
 *     salen de UNA vista, derivada del libro de eventos. No pueden discrepar.
 *   · `gestiones` — los eventos de hoy y de ayer. Con eso la pantalla sabe
 *     quién está gestionado y de cuánto fue el abono sin inferir nada.
 *
 * Se sigue trayendo `payment_plan` porque el cronograma es lo que dice qué
 * cuota toca cobrar y cuánto vale; sus columnas `estado`/`monto_pagado` son
 * un cache que la base mantiene sola.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { guardarCache, leerCache } from "@/lib/offline-cache"
import { todayColombia, ayerColombia, resumenDelDia, COLUMNAS_GESTION, type Gestion } from "@/lib/gestion-core"

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
  /** 'homologado' = venta migrada de otro sistema con su historia. */
  origen?: string
  clients: {
    nombre_completo: string
    apodo: string | null
    documento: string
    // Ubicacion de referencia para la geocerca. null mientras el cliente no
    // haya sido georreferenciado (su primer cobro se la captura).
    latitud: number | null
    longitud: number | null
  }
}

export type PaymentPlanEntry = {
  id: string
  loan_id: string
  numero_cuota: number
  /** VENCIMIENTO de la cuota. Inmutable: ninguna gestión la pisa. */
  fecha_pago: string
  valor_cuota: number
  capital: number
  interes: number
  saldo: number
  /** Cache derivado del libro de eventos (lo escribe `recalcular_prestamo`). */
  estado: string
  fecha_pago_real: string | null
  monto_pagado: number
  ruta?: number
  /** Cuota fuera del plan base: cuota adicional o prórroga americana. */
  es_extra?: boolean
}

/** Fila de `v_loan_financiero`: todo el dinero de un préstamo, derivado. */
export type LoanFinanciero = {
  loan_id: string
  total_a_pagar: number
  total_pagado: number
  /** Saldo del contrato completo (lo que se cobra para cancelar). */
  saldo: number
  /** Lo que el cliente debe HOY (en americano difiere del anterior). */
  saldo_hoy: number
  saldo_en_mora: number
  cuotas_mora: number
  cuotas_cubiertas: number
  cuotas_totales: number
  cuotas_extra: number
  fecha_ultimo_pago: string | null
}

export type DashboardPagosResult = {
  loans: LoanWithClient[]
  /** Lo que el cliente debe hoy, por loan_id. */
  saldoMap: Map<string, number>
  /** Cuotas vencidas sin cubrir, por loan_id. */
  moraMap: Map<string, number>
  /** Fecha del último pago (YYYY-MM-DD), por loan_id. */
  fechaUltimoPagoMap: Map<string, string>
  /** Todo lo financiero derivado, por loan_id. */
  finMap: Map<string, LoanFinanciero>
  /** Eventos aplicados de HOY y AYER en esta ruta (el libro del día). */
  gestiones: Gestion[]
  allPaymentPlans: PaymentPlanEntry[]
  /** "cache" cuando los datos vienen del dispositivo por falta de conexion. */
  source: "direct" | "cache"
  /** Momento en que se trajeron del servidor (solo si source === "cache"). */
  cacheGuardadoEn?: string
}

/**
 * Carga el módulo de pagos con SELECTs paralelos filtrando por ruta.
 * Sin RLS: cada consulta filtra explícitamente.
 */
export async function loadDashboardPagos(
  supabase: SupabaseClient,
  args: {
    rutaId: number
    userId?: number | string | null
    rol?: string | null
  },
): Promise<DashboardPagosResult> {
  // Sin conexion servimos lo ultimo que se trajo del servidor HOY para esta
  // ruta, para que el cobrador pueda cerrar y reabrir la app en campo y
  // seguir trabajando. Si el cache es de otro dia se descarta (mejor una
  // pantalla vacia que mostrarle la ruta de ayer como si fuera la de hoy).
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const guardado = await leerCache<DashboardPagosResult>("dashboard-pagos", args.rutaId)
    if (guardado) {
      console.log("[v0] Dashboard de pagos servido desde cache offline")
      return { ...guardado.datos, source: "cache", cacheGuardadoEn: guardado.guardadoEn }
    }
  }

  // ── 1) Loans de la ruta + eventos recientes, en paralelo ──────────
  //
  // Los eventos se piden por RUTA y no por loan_id porque hacen falta ANTES
  // de decidir qué préstamos entran. Un préstamo que se cancela hoy pasa a
  // `estado = 'cancelado'` (lo hace `recalcular_prestamo`), y si se filtrara
  // solo por "activo" desapareceria de Gestionados en el siguiente refresco:
  // el cobrador acaba de cobrarlo y deja de verlo, sin forma de revisar ni
  // anular esa gestion.
  //
  // Se traen desde AYER porque el flujo "ayer no se gestiono" necesita saber
  // que paso ese dia para ofrecer la gestion retro.
  const desde = ayerColombia()

  const [loansRes, gesRes] = await Promise.all([
    supabase
      .from("loans")
      .select("*, clients(nombre_completo, apodo, documento, latitud, longitud)")
      .eq("ruta", args.rutaId)
      .order("ordenvisita", { ascending: true }),
    supabase
      .from("gestiones")
      .select(COLUMNAS_GESTION)
      .eq("ruta", args.rutaId)
      .eq("estado", "aplicada")
      .gte("fecha_gestion", desde)
      .order("fecha_hora", { ascending: true }),
  ])

  if (loansRes.error) {
    console.error("[v0] loans error:", loansRes.error.message)
    // La red pudo caerse entre el chequeo de arriba y esta consulta.
    const guardado = await leerCache<DashboardPagosResult>("dashboard-pagos", args.rutaId)
    if (guardado) {
      console.log("[v0] Fallo la consulta; sirviendo dashboard desde cache offline")
      return { ...guardado.datos, source: "cache", cacheGuardadoEn: guardado.guardadoEn }
    }
    throw new Error(`loans: ${loansRes.error.message}`)
  }

  const saldoMap = new Map<string, number>()
  const moraMap = new Map<string, number>()
  const fechaUltimoPagoMap = new Map<string, string>()
  const finMap = new Map<string, LoanFinanciero>()
  let gestiones: Gestion[] = []
  let allPaymentPlans: PaymentPlanEntry[] = []

  if (gesRes.error) {
    console.error("[v0] gestiones error:", gesRes.error.message)
  } else {
    gestiones = (gesRes.data ?? []) as unknown as Gestion[]
  }

  const loans = (loansRes.data ?? []) as unknown as LoanWithClient[]

  // Préstamos que se movieron desde ayer. Un cancelado que esté acá sigue
  // entrando: `register-payment` ya lo excluye de Pendientes por su estado,
  // así que solo puede aparecer en Gestionados — que es justo lo que se
  // quiere. Un cancelado SIN eventos recientes se queda fuera, y por eso el
  // historial viejo de la ruta no engorda ninguna de las consultas de abajo.
  const tocadosRecientemente = new Set(gestiones.map((g) => g.loan_id))
  const activeLoans = loans.filter(
    (l) => l.estado === "activo" || !l.estado || tocadosRecientemente.has(l.id),
  )
  const loanIds = activeLoans.map((l) => l.id)

  if (loanIds.length === 0) {
    const vacio: DashboardPagosResult = {
      loans: activeLoans, saldoMap, moraMap, fechaUltimoPagoMap, finMap,
      gestiones, allPaymentPlans, source: "direct",
    }
    void guardarCache("dashboard-pagos", args.rutaId, vacio)
    return vacio
  }

  // ── 2) Financiero + cronograma, en paralelo ──────────────────────
  //
  // Los eventos ya se trajeron arriba: hacian falta para decidir el conjunto
  // de prestamos. Estas dos sí se filtran por loan_id, para que hablen
  // exactamente del mismo conjunto.
  const [finRes, ppRes] = await Promise.all([
    supabase
      .from("v_loan_financiero")
      .select(
        "loan_id, total_a_pagar, total_pagado, saldo, saldo_hoy, saldo_en_mora, " +
          "cuotas_mora, cuotas_cubiertas, cuotas_totales, cuotas_extra, fecha_ultimo_pago",
      )
      .in("loan_id", loanIds),
    supabase
      .from("payment_plan")
      .select(
        "id, loan_id, numero_cuota, valor_cuota, capital, interes, estado, fecha_pago, fecha_pago_real, monto_pagado, es_extra",
      )
      .in("loan_id", loanIds)
      .order("numero_cuota", { ascending: true }),
  ])

  if (finRes.error) {
    console.error("[v0] v_loan_financiero error:", finRes.error.message)
  } else {
    for (const f of (finRes.data ?? []) as unknown as LoanFinanciero[]) {
      finMap.set(f.loan_id, f)
      saldoMap.set(f.loan_id, Number(f.saldo_hoy) || 0)
      moraMap.set(f.loan_id, Number(f.cuotas_mora) || 0)
      if (f.fecha_ultimo_pago) {
        fechaUltimoPagoMap.set(f.loan_id, String(f.fecha_ultimo_pago).split("T")[0])
      }
    }
  }

  if (ppRes.error) {
    console.error("[v0] payment_plan error:", ppRes.error.message)
  } else {
    allPaymentPlans = (ppRes.data ?? []) as unknown as PaymentPlanEntry[]
  }

  const resultado: DashboardPagosResult = {
    loans: activeLoans, saldoMap, moraMap, fechaUltimoPagoMap, finMap,
    gestiones, allPaymentPlans, source: "direct",
  }
  // Se guarda para que la app siga funcionando si el cobrador pierde senal.
  void guardarCache("dashboard-pagos", args.rutaId, resultado)
  return resultado
}

/**
 * Inyecta en el cache offline una gestión recién capturada.
 *
 * Es la otra mitad del arreglo del doble cobro: al encolar sin señal, el
 * cliente debe desaparecer de Pendientes también si el cobrador cierra y
 * reabre la app. Como "gestionado hoy" ahora se decide por la existencia de
 * un evento, basta con agregar el evento al cache.
 */
export function inyectarGestionEnCache(
  datos: DashboardPagosResult,
  gestion: Gestion,
): DashboardPagosResult {
  if (datos.gestiones.some((g) => g.id === gestion.id)) return datos
  const saldoMap = new Map(datos.saldoMap)
  const previo = saldoMap.get(gestion.loan_id)
  if (previo !== undefined && gestion.tipo !== "no_pago") {
    saldoMap.set(gestion.loan_id, Math.max(0, previo - (Number(gestion.monto) || 0)))
  }
  return { ...datos, gestiones: [...datos.gestiones, gestion], saldoMap }
}

/** La fecha de negocio de hoy, reexportada para quien solo importa esta capa. */
export { todayColombia }

/**
 * ¿Quién de la ruta se quedó sin gestionar hoy?
 *
 * LA MISMA CUENTA QUE MUESTRA EL PANEL DE PAGOS. Literalmente: se carga con
 * `loadDashboardPagos` —el mismo cargador— y se decide con `resumenDelDia`
 * —el mismo predicado—. Si el panel dice "42 de 42 gestionados", esto
 * devuelve cero, y el cierre de caja no tiene por qué opinar distinto.
 *
 * POR QUÉ EXISTE
 * El cierre preguntaba otra cosa: cuántas cuotas con vencimiento HOY seguían
 * en estado 'pendiente'. Eso no es lo mismo y no podía serlo:
 *
 *  · Una cuota que vence hoy se queda 'pendiente' aunque el cliente HAYA
 *    pagado, porque la plata se reparte de la cuota más vieja hacia adelante.
 *    Medido en la 151 el 25/08: el cierre reportaba 4 cobros sin marcar y los
 *    CUATRO tenían su pago de ese día registrado.
 *
 *  · Y al revés: una venta hecha hoy, cuya primera cuota es mañana, no tiene
 *    ninguna cuota vencida — pero tampoco hay nada que cobrarle. El cobrador
 *    no la ve en su lista y no tiene forma de "gestionarla".
 *
 * Acá no hay ninguna de las dos trampas, porque no se mira el cronograma: se
 * mira quién tiene saldo y a quién le falta el evento del día. Que es lo que
 * el cobrador ve en pantalla.
 */
export async function clientesSinGestionarHoy(
  supabase: SupabaseClient,
  args: { rutaId: number; userId?: number | string | null; rol?: string | null },
): Promise<{ total: number; sinGestionar: string[] }> {
  const datos = await loadDashboardPagos(supabase, args)
  const hoy = todayColombia()

  // A QUIÉN LE TOCABA HOY.
  //
  // Una venta hecha hoy, cuya primera cuota es mañana, NO cuenta. No se puede
  // estar pendiente de cobrar una deuda que todavía no empieza: el cobrador
  // no tiene nada que hacer con ese cliente y no hay forma de "gestionarlo".
  //
  // Es el caso que bloqueaba el cierre el 25/08: la 151 tenía a NAZARENO
  // (vendido con fecha 26/08) y la 190 a alicia (vendida hoy, primera cuota
  // el 26). Los dos sin una sola cuota vencida, y los dos impidiendo cerrar.
  //
  // Sigue apareciendo en la lista de pagos —se le puede cobrar por adelantado
  // si el cliente quiere— pero no cuenta como tarea del día.
  const tieneAlgoQueCobrar = new Set(
    datos.allPaymentPlans.filter((p) => p.fecha_pago <= hoy).map((p) => p.loan_id),
  )

  const activos = datos.loans.filter(
    (l) => (datos.saldoMap.get(l.id) ?? 0) > 0 && tieneAlgoQueCobrar.has(l.id),
  )
  const faltan = activos.filter((l) => !resumenDelDia(datos.gestiones, l.id, hoy).gestionado)

  return {
    total: activos.length,
    sinGestionar: faltan
      .map((l) => l.clients?.nombre_completo || l.clients?.apodo || "Cliente")
      .sort((a, b) => a.localeCompare(b)),
  }
}
