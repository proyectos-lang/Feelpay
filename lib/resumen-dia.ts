/**
 * lib/resumen-dia.ts
 * ---------------------------------------------------------------------------
 * La fila del Resumen del Día de una ruta, con el arrastre de la caja
 * resuelto.
 *
 * EL PROBLEMA QUE RESUELVE
 * `resumen_diario_v2` solo produce fila para los días que tuvieron ALGO: un
 * evento, un movimiento de caja, una venta, o cuotas venciendo. Un domingo no
 * tiene nada de eso, así que no tiene fila — y las pantallas, al no encontrarla,
 * mostraban **Caja Anterior $0 y Efectivo $0**.
 *
 * Es decir: cada domingo la plata de la ruta desaparecía de la pantalla y
 * reaparecía el lunes. Sobre 316 filas de la base, 72 días sin fila son
 * domingos.
 *
 * La caja no se evapora porque nadie trabaje: si no hubo movimientos, el
 * efectivo sigue siendo exactamente el del último día con registro. Eso es lo
 * que devuelve este helper, y por eso vive acá y no copiado en cada pantalla:
 * el Resumen y el Cierre de Caja tienen que decir el mismo número.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export interface ResumenDiaRow {
  fecha_pago: string
  ruta: number
  meta_pagos: number
  valor_pago: number
  cantidad_pagos: number
  cantidad_no_pagos: number
  cantidad_canceladas: number
  valor_canceladas: number
  pago_capital: number
  pago_intereses: number
  /** El mismo recaudo, partido por forma de pago (script 059). */
  pago_efectivo: number
  pago_transferencia: number
  hora_ultimo_movimiento: string | null
  valor_ingresos: number
  cantidad_ingresos: number
  valor_gastos: number
  cantidad_gastos: number
  valor_retiros: number
  cantidad_retiros: number
  cantidad_ventas: number
  valor_ventas: number
  cantidad_ventas_homologadas: number
  valor_ventas_homologadas: number
  /** Ventas que de verdad sacaron plata de la caja (excluye homologadas). */
  valor_ventas_caja: number
  /** Acumulado de caja al cierre de este día. */
  efectivo: number
  /** El mismo acumulado, sin el neto de este día. */
  caja_anterior: number
}

export interface ResumenDiaResult {
  fila: ResumenDiaRow
  /** true = el día no tenía fila; la caja viene arrastrada del último día. */
  sinMovimiento: boolean
}

function filaVacia(rutaId: number, fecha: string, acumulado: number): ResumenDiaRow {
  return {
    fecha_pago: fecha, ruta: rutaId,
    meta_pagos: 0, valor_pago: 0, cantidad_pagos: 0, cantidad_no_pagos: 0,
    cantidad_canceladas: 0, valor_canceladas: 0,
    pago_capital: 0, pago_intereses: 0,
    pago_efectivo: 0, pago_transferencia: 0,
    hora_ultimo_movimiento: null,
    valor_ingresos: 0, cantidad_ingresos: 0,
    valor_gastos: 0, cantidad_gastos: 0,
    valor_retiros: 0, cantidad_retiros: 0,
    cantidad_ventas: 0, valor_ventas: 0,
    cantidad_ventas_homologadas: 0, valor_ventas_homologadas: 0,
    valor_ventas_caja: 0,
    // Sin movimientos, el cierre del día es igual a su apertura.
    efectivo: acumulado, caja_anterior: acumulado,
  }
}

/**
 * Devuelve el resumen de esa ruta en esa fecha. Si el día no tiene fila,
 * devuelve una en ceros que conserva el efectivo acumulado del último día
 * con registro, y avisa con `sinMovimiento` para que la pantalla lo pueda
 * decir en vez de dejar creer que la caja está vacía.
 */
export async function getResumenDia(
  supabase: SupabaseClient,
  rutaId: number,
  fecha: string,
): Promise<ResumenDiaResult> {
  const { data, error } = await supabase
    .from("resumen_diario_v2")
    .select("*")
    .eq("ruta", rutaId)
    .eq("fecha_pago", fecha)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (data) return { fila: data as unknown as ResumenDiaRow, sinMovimiento: false }

  // Sin fila: se arrastra el acumulado del último día que sí la tuvo.
  const { data: previo, error: errPrevio } = await supabase
    .from("resumen_diario_v2")
    .select("efectivo")
    .eq("ruta", rutaId)
    .lt("fecha_pago", fecha)
    .order("fecha_pago", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (errPrevio) console.error("[v0] resumen_dia acumulado previo:", errPrevio.message)

  const acumulado = Number((previo as { efectivo?: number } | null)?.efectivo ?? 0)
  return { fila: filaVacia(rutaId, fecha, acumulado), sinMovimiento: true }
}

/**
 * Lo mismo que `getResumenDia` pero para varias rutas de un solo día — lo que
 * necesita el dashboard del admin.
 *
 * Sin esto, las rutas que no tuvieron movimiento ese día simplemente NO
 * aparecían en el tablero: un domingo el admin veía la lista vacía y no había
 * forma de saber si era que nadie trabajó o que algo se rompió.
 */
export async function getResumenDiaRutas(
  supabase: SupabaseClient,
  rutaIds: number[],
  fecha: string,
): Promise<Map<number, ResumenDiaResult>> {
  const out = new Map<number, ResumenDiaResult>()
  if (rutaIds.length === 0) return out

  const { data, error } = await supabase
    .from("resumen_diario_v2")
    .select("*")
    .eq("fecha_pago", fecha)
    .in("ruta", rutaIds)
  if (error) throw new Error(error.message)

  for (const f of (data ?? []) as unknown as ResumenDiaRow[]) {
    out.set(Number(f.ruta), { fila: f, sinMovimiento: false })
  }

  // Las que no tuvieron fila conservan su efectivo acumulado. Son pocas
  // rutas, así que se resuelven en paralelo.
  const faltantes = rutaIds.filter((id) => !out.has(id))
  await Promise.all(
    faltantes.map(async (id) => {
      const { data: previo } = await supabase
        .from("resumen_diario_v2")
        .select("efectivo")
        .eq("ruta", id)
        .lt("fecha_pago", fecha)
        .order("fecha_pago", { ascending: false })
        .limit(1)
        .maybeSingle()
      const acumulado = Number((previo as { efectivo?: number } | null)?.efectivo ?? 0)
      out.set(id, { fila: filaVacia(id, fecha, acumulado), sinMovimiento: true })
    }),
  )

  return out
}
