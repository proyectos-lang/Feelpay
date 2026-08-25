"use client"

/**
 * lib/movimientos.ts
 * ---------------------------------------------------------------------------
 * Ingresos, gastos y retiros: un solo vocabulario para las tres pantallas que
 * los muestran (Ver Gastos, Auditoría 360 y Control Total).
 *
 * Se escribió acá y no en cada vista por lo mismo que `gestion-core.ts`: la
 * pregunta "¿este movimiento se puede editar?" tiene UNA respuesta, y si cada
 * pantalla la deduce por su cuenta terminan discrepando — una deja editar lo
 * que la otra bloquea.
 *
 * LOS ESTADOS, QUE NO SON OBVIOS
 * `estadoadmin` y `estadosecre` no son "aprobado / no aprobado". Valen:
 *   'NA'          → no necesitó aprobación (quedó por debajo del umbral del
 *                   item). OJO: esto NO es "pendiente" — la vista
 *                   `resumen_pagos_diarios` ya lo suma como plata autorizada.
 *   'por aprobar' → esperando firma.
 *   'aprobado' / 'rechazado' → alguien ya lo resolvió.
 *
 * De ahí sale la regla: un movimiento está ABIERTO mientras nadie lo haya
 * resuelto, y eso incluye los 'NA'. Si "editable" se hubiera atado solo a
 * 'por aprobar', la opción no aplicaría a casi ningún movimiento real.
 */

import { createClient } from "@/lib/supabase/client"
import { todayColombia, tsToColombiaDate } from "@/lib/colombia-date"

export type TipoMovimiento = "Ingreso" | "Gasto" | "Retiro"

export const TIPOS_MOVIMIENTO: TipoMovimiento[] = ["Ingreso", "Gasto", "Retiro"]

/**
 * De qué tabla sale el catálogo de conceptos de cada tipo.
 *
 * Vivía duplicado en el diálogo de edición. Ahora lo comparten el que edita y
 * el que registra: si mañana se agrega un cuarto tipo, hay UN sitio donde
 * acordarse, no dos que pueden quedar en desacuerdo.
 */
// La clave es `string` y no `TipoMovimiento` a propósito: `Movimiento.tipo`
// viene de la base como texto libre, y el código que lo usa ya comprueba que
// haya salido una tabla antes de consultarla.
export const TABLA_CATALOGO: Record<string, string> = {
  Ingreso: "ingresos",
  Gasto: "gastos",
  Retiro: "retiros",
}

export interface Movimiento {
  id: number
  fechahorasol: string
  adminid: number | null
  ruta: number
  concepto: string
  limite: number | null
  valor: number
  observacion: string | null
  foto: string | null
  tipo: string
  estadoadmin: string
  adminaprobo: string | null
  fechahoraaproboadm: string | null
  estadosecre: string
  secretariaaprobo: string | null
  fechahoraaprobosecretaria: string | null
  // Rastro de edición (script 051). `veces_editado = 0` = nunca se tocó.
  editado_por: string | null
  fechahoraedicion: string | null
  veces_editado: number | null
  valor_anterior: number | null
  concepto_anterior: string | null
  observacion_anterior: string | null
}

/**
 * Se lee con `*` y no con una lista explícita a propósito.
 *
 * Nombrar `editado_por`, `veces_editado` y compañía haría que la consulta
 * fallara entera con un 400 mientras el script 051 no se haya corrido, y las
 * tres pantallas quedarían en blanco por unas columnas que solo sirven para
 * un badge. Con `*` la lista funciona desde el primer día: el rastro de
 * edición simplemente no aparece hasta que existan las columnas — por eso
 * todos los campos del rastro se leen con `?? 0` o comparando contra null.
 */
const COLUMNAS = "*"

/** Estados en los que nadie resolvió todavía el movimiento. */
const ESTADOS_ABIERTOS = ["NA", "por aprobar"]

/** Nadie lo ha aprobado ni rechazado — ni el admin ni secretaría. */
export function movimientoAbierto(m: Pick<Movimiento, "estadoadmin" | "estadosecre">): boolean {
  return (
    ESTADOS_ABIERTOS.includes(m.estadoadmin ?? "NA") &&
    ESTADOS_ABIERTOS.includes(m.estadosecre ?? "NA")
  )
}

/** ¿Se editó alguna vez? Gobierna el badge "editado" de las listas. */
export function movimientoEditado(m: Pick<Movimiento, "veces_editado">): boolean {
  return (m.veces_editado ?? 0) > 0
}

export interface PermisoEdicion {
  puede: boolean
  /** Por qué no, para poder decírselo al usuario en vez de solo deshabilitar. */
  motivo?: string
}

/**
 * ¿Puede el asesor editar este movimiento?
 *
 * Tres condiciones, y el orden importa para que el mensaje sea el útil: si es
 * de otro Y de ayer, lo primero que hay que decirle es que no es suyo.
 */
export function puedeEditarComoAsesor(m: Movimiento, userId: number | null): PermisoEdicion {
  if (userId === null || m.adminid !== userId) {
    return { puede: false, motivo: "Solo puedes editar los movimientos que registraste tú" }
  }
  if (tsToColombiaDate(m.fechahorasol) !== todayColombia()) {
    return { puede: false, motivo: "Solo puedes editar los movimientos de hoy" }
  }
  if (!movimientoAbierto(m)) {
    return { puede: false, motivo: "Ya fue aprobado o rechazado: pídele el cambio a secretaría" }
  }
  return { puede: true }
}

/**
 * ¿Se puede ELIMINAR este movimiento?
 *
 * Dos condiciones para todos —del día de hoy y sin resolver— y una tercera
 * solo para el asesor: que sea suyo.
 *
 * SECRETARÍA TAMBIÉN QUEDA ATADA AL DÍA, y eso es distinto de lo que pasa con
 * editar. Corregir un movimiento viejo deja la corrección a la vista, con su
 * firma y el valor anterior; borrarlo lo hace DESAPARECER de la caja de un día
 * que probablemente ya se cerró y se aprobó. Para eso está editar.
 */
export function puedeEliminar(
  m: Movimiento,
  userId: number | null,
  opts: { comoAsesor: boolean },
): PermisoEdicion {
  if (opts.comoAsesor && (userId === null || m.adminid !== userId)) {
    return { puede: false, motivo: "Solo puedes eliminar los movimientos que registraste tú" }
  }
  if (tsToColombiaDate(m.fechahorasol) !== todayColombia()) {
    return { puede: false, motivo: "Solo se pueden eliminar los movimientos de hoy" }
  }
  if (!movimientoAbierto(m)) {
    return { puede: false, motivo: "Ya fue aprobado o rechazado: corrígelo en vez de borrarlo" }
  }
  return { puede: true }
}

/**
 * Movimientos de una ruta en un rango de días Colombia.
 *
 * El rango se convierte a instantes UTC en vez de filtrar por el texto de la
 * fecha: `fechahorasol` es timestamptz, y comparar contra "YYYY-MM-DD" dejaba
 * fuera lo registrado después de las 7pm (que en UTC ya es el día siguiente).
 */
export async function getMovimientos(opts: {
  rutaId?: number | "todas"
  desde: string
  hasta: string
}): Promise<Movimiento[]> {
  const desdeUtc = new Date(`${opts.desde}T00:00:00-05:00`).toISOString()
  // Exclusivo por arriba: se pide "< el día siguiente a las 00:00".
  const hastaDt = new Date(`${opts.hasta}T00:00:00-05:00`)
  hastaDt.setUTCDate(hastaDt.getUTCDate() + 1)

  let q = createClient()
    .from("gastosregistros")
    .select(COLUMNAS)
    .gte("fechahorasol", desdeUtc)
    .lt("fechahorasol", hastaDt.toISOString())
    .order("fechahorasol", { ascending: false })

  // No hay RLS: si no se filtra por ruta se ven las de todas las unidades.
  if (opts.rutaId !== undefined && opts.rutaId !== "todas") {
    q = q.eq("ruta", opts.rutaId)
  }

  const { data, error } = await q
  if (error) {
    console.error("[v0] Error cargando movimientos:", error.message)
    throw new Error(error.message)
  }
  return (data ?? []) as unknown as Movimiento[]
}

/** Totales por tipo, para las tarjetas de resumen de las listas. */
export function totalesPorTipo(movs: Movimiento[]): Record<TipoMovimiento, number> {
  const acc: Record<TipoMovimiento, number> = { Ingreso: 0, Gasto: 0, Retiro: 0 }
  for (const m of movs) {
    if (m.tipo === "Ingreso" || m.tipo === "Gasto" || m.tipo === "Retiro") {
      acc[m.tipo] += Number(m.valor) || 0
    }
  }
  return acc
}

/** Identidad del usuario en sesión, para saber qué puede editar y firmar. */
export function getUsuarioSesion(): { id: number | null; nombre: string } {
  if (typeof window === "undefined") return { id: null, nombre: "" }
  try {
    const raw = localStorage.getItem("currentUser")
    if (!raw) return { id: null, nombre: "" }
    const u = JSON.parse(raw)
    return { id: typeof u?.id === "number" ? u.id : null, nombre: u?.nombre ?? "" }
  } catch {
    return { id: null, nombre: "" }
  }
}
