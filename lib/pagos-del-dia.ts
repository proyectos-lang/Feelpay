/**
 * lib/pagos-del-dia.ts
 * ---------------------------------------------------------------------------
 * Quién pagó hoy en esta ruta, cuánto, y cuántas cuotas alcanzó a cubrir.
 *
 * SALE DEL LIBRO, NO DEL CRONOGRAMA. El contador de la tarjeta ("8 pagos")
 * viene de `resumen_diario_v2.cantidad_pagos`, que cuenta clientes con neto
 * positivo en el día. Si esta lista se armara con las cuotas de
 * `payment_plan` daría otra cosa —una cuota que vence hoy sigue pendiente
 * aunque el cliente pague, porque la plata tapa primero lo viejo— y el ojito
 * mostraría una lista distinta del número que lo abrió.
 *
 * UN CLIENTE, UNA FILA. Se aplica la misma regla del script 070: los eventos
 * del día se netean por préstamo. Si alguien pagó, se corrigió el monto y se
 * volvió a pagar, eso es UN pago por el neto, no tres.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  colapsarPorCliente, montoEfectivo, COLUMNAS_GESTION, type Gestion,
} from "@/lib/gestion-core"

export interface PagoDelDiaRow {
  loanId: string
  clientId: string
  nombre: string
  apodo: string | null
  /** Lo que entregó hoy, ya neteado. */
  pago: number
  valorCuota: number
  /**
   * Cuántas cuotas alcanzó a cubrir ESE pago: `pago / valor_cuota`.
   *
   * Lleva decimales a propósito. Pagar 40.000 de una cuota de 19.500 son
   * 2,05 cuotas, y pagar 13.000 de una de 19.500 son 0,67. Redondearlo a
   * entero escondería justo lo que la columna existe para mostrar.
   */
  cuotasPagas: number
  /** Cuántas cuotas tiene el crédito en total. Se usa en el modo grupo. */
  cuotasTotales: number
  /**
   * Qué pasó con el cliente:
   *   'Cancelada'  el crédito quedó en cero
   *   'Abono'      entró plata y todavía debe
   *   'No pago'    se le visitó y no pagó
   */
  movimiento: "Abono" | "Cancelada" | "No pago"
  /**
   * CÓMO pagó ese día: 'Efectivo', 'Transferencia' o 'Mixto'.
   *
   * `null` donde la pregunta no aplica o la respuesta sería una columna
   * repitiendo la misma palabra: en los no pagos, en el grupo de créditos, y
   * en las listas que YA están filtradas por método —ahí todas las filas
   * dirían lo mismo que el título.
   *
   * 'Mixto' no ha pasado nunca: en 497 clientes-día de la base, ninguno pagó
   * de las dos formas el mismo día. Se contempla porque nada lo impide, no
   * porque se espere.
   */
  formaPago: "Efectivo" | "Transferencia" | "Mixto" | null
  saldo: number
}

/** Ficha completa de la venta más su libro, para el ojo de "Historial". */
export interface HistorialCredito {
  valorVenta: number
  totalAPagar: number
  tasaInteres: number
  numeroCuotas: number
  frecuencia: string | null
  tipoAmortizacion: string | null
  fechaVenta: string | null
  totalPagado: number
  saldo: number
  cuotasCubiertas: number
  cuotasTotales: number
  eventos: {
    fecha: string
    tipo: string
    monto: number
    observacion: string | null
    anulado: boolean
  }[]
}

/** Qué rebanada del día se quiere ver. */
export type ModoDia = "pagos" | "no_pagos" | "efectivo" | "transferencia"

/**
 * LA FORMA DE PAGO DE UN EVENTO, con la misma regla del script 070:
 *
 *   · lo que diga `metodo_pago`, si dice algo;
 *   · si es una reversa, la del evento que revierte (`ref`) — sin esto,
 *     anular una transferencia restaría del efectivo;
 *   · y si no hay nada, EFECTIVO. Hoy 536 de 1.000 eventos vienen en null y
 *     así los cuenta la vista, así que contarlos de otra forma acá dejaría la
 *     lista peleada con la cifra que la abre.
 */
/** De los dos baldes de un cliente a la palabra que va en la tabla. */
function clasificar(
  b: { efectivo: number; transferencia: number } | undefined,
): PagoDelDiaRow["formaPago"] {
  if (!b) return null
  const ef = Math.abs(b.efectivo) > 0.001
  const tr = Math.abs(b.transferencia) > 0.001
  if (ef && tr) return "Mixto"
  if (tr) return "Transferencia"
  if (ef) return "Efectivo"
  return null
}

function formaDePago(g: Gestion, refs: Map<string, string | null>): "efectivo" | "transferencia" {
  const propio = (g.metodo_pago ?? "").trim()
  const heredado = g.referencia_gestion_id ? (refs.get(g.referencia_gestion_id) ?? "").trim() : ""
  const m = (propio || heredado || "efectivo").toLowerCase()
  return m === "transferencia" ? "transferencia" : "efectivo"
}

/**
 * Las rebanadas de la visita del día.
 *
 *   'pagos'          quien dejó plata            (neto > 0)
 *   'no_pagos'       quien fue visitado y no     (neto <= 0 con un no_pago)
 *   'efectivo'       la parte del recaudo que entró en billetes
 *   'transferencia'  la que entró por cuenta
 *
 * Las dos primeras salen del MISMO colapso por cliente, que es la regla del
 * script 070: un cliente, un día, un resultado. Por eso suman exactamente los
 * dos contadores de la tarjeta y nunca se pisan.
 *
 * LAS DOS ÚLTIMAS SE NETEAN POR CLIENTE **Y POR MÉTODO**, que es como las
 * calcula `resumen_diario_v2`. Un cliente que pagó una parte en efectivo y
 * otra por transferencia sale en las dos listas, con la parte que le toca a
 * cada una — no es un duplicado, es que pagó de dos formas.
 *
 * Y se conservan los netos NEGATIVOS. Suena raro ver "−$19.500" en una lista
 * de pagos, pero es lo que pasó: ese día se le anuló un pago en efectivo. Hay
 * dos casos así en la base. Filtrarlos dejaría la suma de la lista por encima
 * de la cifra de la tarjeta, y el ojito existe justamente para explicar esa
 * cifra.
 */
export async function getPagosDelDia(
  supabase: SupabaseClient,
  rutaId: number,
  fecha: string,
  modo: ModoDia = "pagos",
): Promise<PagoDelDiaRow[]> {
  try {
    const { data: ges, error } = await supabase
      .from("gestiones")
      .select(COLUMNAS_GESTION)
      .eq("ruta", rutaId)
      .eq("fecha_gestion", fecha)
      .eq("estado", "aplicada")
      .neq("origen", "homologacion")
    if (error) throw error

    const eventos = (ges ?? []) as unknown as Gestion[]
    const porMetodo = modo === "efectivo" || modo === "transferencia"

    // Lo pagado por cada cliente, separado por forma de pago. Sirve para dos
    // cosas: armar las listas de 'efectivo' y 'transferencia', y clasificar
    // cada fila de la lista general. Se calcula una vez.
    const baldesPorLoan = new Map<string, { efectivo: number; transferencia: number }>()

    let filas: { loanId: string; neto: number }[]
    if (modo !== "no_pagos") {
      // El método de una reversa lo pone el evento que revierte, y ese puede
      // no estar en la tanda del día. Hoy no pasa —ninguna reversa de la base
      // apunta a otro día— pero cuesta una consulta que casi siempre no se
      // hace, y sin ella una anulación se contaría en el balde equivocado.
      const enLaTanda = new Set(eventos.map((g) => g.id))
      const refs = new Map<string, string | null>(
        eventos.map((g) => [g.id, g.metodo_pago]),
      )
      const faltantes = [
        ...new Set(
          eventos
            .map((g) => g.referencia_gestion_id)
            .filter((id): id is string => !!id && !enLaTanda.has(id)),
        ),
      ]
      if (faltantes.length > 0) {
        const { data: ext } = await supabase
          .from("gestiones")
          .select("id, metodo_pago")
          .in("id", faltantes)
        for (const r of (ext ?? []) as { id: string; metodo_pago: string | null }[]) {
          refs.set(r.id, r.metodo_pago)
        }
      }

      for (const g of eventos) {
        const monto = montoEfectivo(g)
        if (monto === 0) continue
        const b = baldesPorLoan.get(g.loan_id) ?? { efectivo: 0, transferencia: 0 }
        b[formaDePago(g, refs)] += monto
        baldesPorLoan.set(g.loan_id, b)
      }
    }

    if (porMetodo) {
      filas = [...baldesPorLoan.entries()]
        .map(([loanId, b]) => ({ loanId, neto: b[modo as "efectivo" | "transferencia"] }))
        .filter((f) => f.neto !== 0)
    } else {
      filas = colapsarPorCliente(eventos)
        .filter((f) => (modo === "pagos" ? f.estado === "pagado" : f.estado === "no_pago"))
        .map((f) => ({ loanId: f.loanId, neto: f.neto }))
    }
    if (filas.length === 0) return []

    const loanIds = filas.map((f) => f.loanId)
    const [prestamos, financiero] = await Promise.all([
      supabase
        .from("loans")
        .select("id, client_id, valor_cuota, clients:clients(nombre_completo, apodo)")
        .in("id", loanIds),
      supabase
        .from("v_loan_financiero")
        .select("loan_id, saldo, cuotas_totales")
        .in("loan_id", loanIds),
    ])

    const info = new Map(
      ((prestamos.data ?? []) as Record<string, any>[]).map((l) => [String(l.id), l]),
    )
    const fin = new Map(
      ((financiero.data ?? []) as { loan_id: string; saldo: number; cuotas_totales: number }[])
        .map((f) => [f.loan_id, f]),
    )

    return filas
      .map((f) => {
        const l = info.get(f.loanId)
        const valorCuota = Number(l?.valor_cuota) || 0
        const saldo = Number(fin.get(f.loanId)?.saldo) || 0
        return {
          loanId: f.loanId,
          clientId: String(l?.client_id ?? ""),
          nombre: l?.clients?.nombre_completo ?? "Cliente",
          apodo: l?.clients?.apodo ?? null,
          // En un no pago el neto puede ser negativo (un pago anulado ese
          // mismo día). Mostrar "−$20.000" en la columna del pago no diría
          // nada: lo que pasó es que no pagó.
          pago: modo === "no_pagos" ? 0 : f.neto,
          valorCuota,
          // Sin valor de cuota no se puede dividir; se muestra 0 en vez de
          // inventar un número o reventar con una división por cero.
          cuotasPagas: modo !== "no_pagos" && valorCuota > 0 ? f.neto / valorCuota : 0,
          cuotasTotales: Number(fin.get(f.loanId)?.cuotas_totales) || 0,
          movimiento: (modo === "no_pagos"
            ? "No pago"
            : saldo <= 0
              ? "Cancelada"
              : "Abono") as PagoDelDiaRow["movimiento"],
          // Solo en la lista general. En las que ya vienen filtradas por
          // método sería una columna repitiendo el título.
          formaPago: modo === "pagos" ? clasificar(baldesPorLoan.get(f.loanId)) : null,
          saldo,
        }
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
  } catch (err) {
    console.error("[v0] getPagosDelDia:", err)
    // Nunca lanza: un detalle que revienta no puede tumbar la tarjeta que lo
    // abrió. Mismo criterio que `getDetalleClientes`.
    return []
  }
}

/**
 * Los mismos datos, pero para un GRUPO DE CRÉDITOS en vez de un día.
 *
 * Lo usa el ojito de "Cuotas Clientes", que agrupa clientes por cuántas
 * cuotas llevan pagas. Devuelve la misma forma de fila para que la tabla sea
 * literalmente la misma —una sola tabla, un solo sitio donde arreglarla— y
 * cambia lo que significa cada número, que es lo único que cambia de verdad:
 *
 *   `pago`        lo que el cliente lleva pagado del crédito ENTERO, no lo
 *                 de hoy: en esta lista la mayoría no pagó hoy, y una
 *                 columna de ceros no dice nada.
 *   `cuotasPagas` las cuotas SALDADAS (`cuotas_cubiertas`), que es el número
 *                 con el que la tarjeta arma los grupos. Sin decimales.
 *
 * NO SE CONSULTA POR CRITERIO, SE CONSULTA POR `loan_id`: quien pinta el
 * contador ya sabe qué créditos lo componen. Repetir el criterio acá dejaría
 * que la lista y el número se separaran.
 */
export async function getCreditosComoFilas(
  supabase: SupabaseClient,
  loanIds: string[],
): Promise<PagoDelDiaRow[]> {
  const ids = Array.from(new Set(loanIds.filter(Boolean)))
  if (ids.length === 0) return []
  try {
    const filas: PagoDelDiaRow[] = []
    // Por tandas: un `.in()` con doscientos y pico UUID revienta la URL de
    // PostgREST, y revienta en silencio. Mismo criterio que detalle-clientes.
    for (let i = 0; i < ids.length; i += 150) {
      const tanda = ids.slice(i, i + 150)
      const [prestamos, financiero] = await Promise.all([
        supabase
          .from("loans")
          .select("id, client_id, valor_cuota, clients:clients(nombre_completo, apodo)")
          .in("id", tanda),
        supabase
          .from("v_loan_financiero")
          .select("loan_id, saldo, total_pagado, cuotas_cubiertas, cuotas_totales")
          .in("loan_id", tanda),
      ])
      const fin = new Map(
        ((financiero.data ?? []) as Record<string, unknown>[]).map((f) => [String(f.loan_id), f]),
      )
      for (const l of (prestamos.data ?? []) as Record<string, any>[]) {
        const f = fin.get(String(l.id)) ?? {}
        const saldo = Number(f.saldo) || 0
        filas.push({
          loanId: String(l.id),
          clientId: String(l.client_id ?? ""),
          nombre: l.clients?.nombre_completo ?? "Cliente",
          apodo: l.clients?.apodo ?? null,
          pago: Number(f.total_pagado) || 0,
          valorCuota: Number(l.valor_cuota) || 0,
          cuotasPagas: Number(f.cuotas_cubiertas) || 0,
          cuotasTotales: Number(f.cuotas_totales) || 0,
          movimiento: saldo <= 0 ? "Cancelada" : "Abono",
          // La forma de pago es de UN día. Acá `pago` es lo acumulado del
          // crédito entero, que puede haber entrado de las dos maneras a lo
          // largo de meses: no hay una respuesta que dar.
          formaPago: null,
          saldo,
        })
      }
    }
    return filas.sort((a, b) => (a.apodo || a.nombre).localeCompare(b.apodo || b.nombre, "es"))
  } catch (err) {
    console.error("[v0] getCreditosComoFilas:", err)
    return []
  }
}

/** La venta y todo su libro. Se pide al abrir el ojo de Historial, no antes. */
export async function getHistorialCredito(
  supabase: SupabaseClient,
  loanId: string,
): Promise<HistorialCredito | null> {
  try {
    const [prestamo, financiero, eventos] = await Promise.all([
      supabase
        .from("loans")
        .select("valor, valor_a_pagar, tasa_interes, numero_cuotas, frecuencia_pago, tipo_amortizacion, fecha_creacion")
        .eq("id", loanId)
        .maybeSingle(),
      supabase
        .from("v_loan_financiero")
        .select("total_pagado, saldo, cuotas_cubiertas, cuotas_totales")
        .eq("loan_id", loanId)
        .maybeSingle(),
      supabase
        .from("gestiones")
        .select("id, fecha_gestion, fecha_hora, tipo, monto, observacion, referencia_gestion_id, estado")
        .eq("loan_id", loanId)
        .eq("estado", "aplicada")
        .order("fecha_hora", { ascending: false }),
    ])

    const l = prestamo.data as Record<string, any> | null
    if (!l) return null
    const f = (financiero.data ?? {}) as Record<string, any>
    const evs = (eventos.data ?? []) as Record<string, any>[]

    // Un evento con una reversa aplicada apuntándole se marca anulado en vez
    // de esconderse: el historial es para entender qué pasó, y una corrección
    // es parte de lo que pasó.
    const anulados = new Set(
      evs.filter((e) => e.tipo === "reversa" && e.referencia_gestion_id)
         .map((e) => String(e.referencia_gestion_id)),
    )

    return {
      valorVenta: Number(l.valor) || 0,
      totalAPagar: Number(l.valor_a_pagar ?? l.valor) || 0,
      tasaInteres: Number(l.tasa_interes) || 0,
      numeroCuotas: Number(l.numero_cuotas) || 0,
      frecuencia: l.frecuencia_pago ?? null,
      tipoAmortizacion: l.tipo_amortizacion ?? null,
      fechaVenta: l.fecha_creacion ? String(l.fecha_creacion).slice(0, 10) : null,
      totalPagado: Number(f.total_pagado) || 0,
      saldo: Number(f.saldo) || 0,
      cuotasCubiertas: Number(f.cuotas_cubiertas) || 0,
      cuotasTotales: Number(f.cuotas_totales) || 0,
      eventos: evs.map((e) => ({
        fecha: String(e.fecha_gestion ?? "").slice(0, 10),
        tipo: String(e.tipo),
        monto: Number(e.monto) || 0,
        observacion: e.observacion ?? null,
        anulado: anulados.has(String(e.id)),
      })),
    }
  } catch (err) {
    console.error("[v0] getHistorialCredito:", err)
    return null
  }
}
