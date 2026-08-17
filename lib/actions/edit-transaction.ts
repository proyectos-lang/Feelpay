"use server"

import { getSupabaseServer } from "@/lib/supabase/server"

/**
 * Editar un movimiento de caja (ingreso / gasto / retiro).
 *
 * Las otras dos escrituras de `gastosregistros` (saveTransaction y
 * approveTransaction) viven acá como server actions; esta también, para que
 * quien busque cómo se toca esa tabla encuentre las tres juntas.
 *
 * ESTO ES PLATA. `resumen_pagos_diarios` suma los movimientos con
 * `estadosecre = 'aprobado' OR estadoadmin = 'NA'`, así que corregir el valor
 * de un movimiento 'NA' cambia la caja de ese día hacia atrás. Por eso cada
 * edición deja firma y guarda lo que decía antes (script 051).
 */
interface EditTransactionParams {
  id: number
  concepto: string
  valor: number
  observacion: string
  /** Nombre de quien edita — queda en `editado_por`. */
  editadoPor: string
  /**
   * Restricciones del asesor. Cuando viene, la edición solo procede si el
   * movimiento es SUYO y del día indicado. Secretaría manda esto vacío: desde
   * Control Total puede corregir cualquiera, que es para lo que existe.
   */
  restringirA?: {
    adminid: number
    /** Día Colombia "YYYY-MM-DD" al que debe pertenecer el movimiento. */
    fechaColombia: string
  }
}

/** Estados en los que un movimiento todavía no fue resuelto por nadie. */
const ESTADOS_ABIERTOS = ["NA", "por aprobar"]

/**
 * Las columnas del rastro (script 051) todavía no están en los tipos
 * generados de Supabase, así que `update()` resuelve su parámetro a `never`.
 * Se castea igual que `save-transaction.ts` hace con operaciones_procesadas.
 */
type FiltroSinTipos = {
  eq: (col: string, val: unknown) => FiltroSinTipos
  in: (col: string, vals: unknown[]) => FiltroSinTipos
  select: (cols: string) => Promise<{
    data: { id: number }[] | null
    error: { message: string } | null
  }>
}
type TablaSinTipos = {
  update: (row: Record<string, unknown>) => FiltroSinTipos
}

export async function editTransaction(params: EditTransactionParams) {
  try {
    if (!params.concepto?.trim()) {
      return { success: false, error: "El concepto es obligatorio" }
    }
    if (!(params.valor > 0)) {
      return { success: false, error: "El valor debe ser mayor a cero" }
    }

    const supabase = await getSupabaseServer()

    // Se leen los valores actuales para poder guardarlos como "anterior".
    // `*` y no una lista explícita: nombrar `veces_editado` haría que esta
    // lectura fallara con un 400 antes de correr el script 051, y el mensaje
    // que vería el usuario sería sobre una columna en vez de sobre el
    // movimiento. Así el único que falla es el UPDATE, que es el que de
    // verdad necesita las columnas nuevas.
    const { data: actual, error: readErr } = await supabase
      .from("gastosregistros")
      .select("*")
      .eq("id", params.id)
      .maybeSingle()

    if (readErr) {
      console.error("[v0] Error leyendo el movimiento a editar:", readErr)
      return { success: false, error: readErr.message }
    }
    if (!actual) {
      return { success: false, error: "El movimiento ya no existe" }
    }

    const previo = actual as {
      concepto: string | null
      valor: number | null
      observacion: string | null
      estadoadmin: string | null
      estadosecre: string | null
      adminid: number | null
      fechahorasol: string
      veces_editado: number | null
    }

    // ── Reglas del asesor ─────────────────────────────────────────────────
    // Se revisan ACÁ y además se repiten como guardas del UPDATE: el chequeo
    // previo da un mensaje que explica por qué no se pudo, y las guardas
    // atrapan la carrera de que alguien apruebe el movimiento entremedio.
    if (params.restringirA) {
      if (previo.adminid !== params.restringirA.adminid) {
        return { success: false, error: "Solo puedes editar los movimientos que registraste tú" }
      }
      const diaColombia = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(previo.fechahorasol))
      if (diaColombia !== params.restringirA.fechaColombia) {
        return { success: false, error: "Solo puedes editar los movimientos de hoy" }
      }
      if (
        !ESTADOS_ABIERTOS.includes(previo.estadoadmin ?? "NA") ||
        !ESTADOS_ABIERTOS.includes(previo.estadosecre ?? "NA")
      ) {
        return { success: false, error: "Este movimiento ya fue aprobado o rechazado y no se puede editar" }
      }
    }

    let q = (supabase.from("gastosregistros") as unknown as TablaSinTipos).update({
      concepto: params.concepto.trim(),
      valor: params.valor,
      observacion: params.observacion ?? "",
      editado_por: params.editadoPor,
      fechahoraedicion: new Date().toISOString(),
      veces_editado: (previo.veces_editado ?? 0) + 1,
      valor_anterior: previo.valor,
      concepto_anterior: previo.concepto,
      observacion_anterior: previo.observacion,
    }).eq("id", params.id)

    // Las guardas solo aplican al asesor. Secretaría corrige movimientos ya
    // aprobados a propósito: es el único camino cuando el error se detecta
    // después de la firma.
    if (params.restringirA) {
      q = q
        .eq("adminid", params.restringirA.adminid)
        .in("estadoadmin", ESTADOS_ABIERTOS)
        .in("estadosecre", ESTADOS_ABIERTOS)
    }

    const { data, error } = await q.select("id")

    if (error) {
      console.error("[v0] Error editando el movimiento:", error)
      return { success: false, error: error.message }
    }
    if (!data || data.length === 0) {
      return { success: false, error: "Este movimiento acaba de ser resuelto por otra persona" }
    }

    return { success: true, message: "Movimiento actualizado" }
  } catch (error) {
    console.error("[v0] Error in editTransaction:", error)
    return { success: false, error: error instanceof Error ? error.message : "Error desconocido" }
  }
}
