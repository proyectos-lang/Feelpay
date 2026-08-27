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
import { colapsarPorCliente, COLUMNAS_GESTION, type Gestion } from "@/lib/gestion-core"

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
  /** 'Cancelada' cuando el crédito quedó en cero; si no, 'Abono'. */
  movimiento: "Abono" | "Cancelada"
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

export async function getPagosDelDia(
  supabase: SupabaseClient,
  rutaId: number,
  fecha: string,
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

    const filas = colapsarPorCliente((ges ?? []) as unknown as Gestion[])
      .filter((f) => f.neto > 0)
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
          pago: f.neto,
          valorCuota,
          // Sin valor de cuota no se puede dividir; se muestra 0 en vez de
          // inventar un número o reventar con una división por cero.
          cuotasPagas: valorCuota > 0 ? f.neto / valorCuota : 0,
          cuotasTotales: Number(fin.get(f.loanId)?.cuotas_totales) || 0,
          movimiento: (saldo <= 0 ? "Cancelada" : "Abono") as "Abono" | "Cancelada",
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
