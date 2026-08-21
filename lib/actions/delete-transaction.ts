"use server"

import { getSupabaseServer } from "@/lib/supabase/server"

/**
 * Borrar un movimiento de caja (ingreso / gasto / retiro).
 *
 * Es la cuarta escritura de `gastosregistros`, junto a `saveTransaction`,
 * `approveTransaction` y `editTransaction`. Viven las cuatro acá para que
 * quien busque cómo se toca esa tabla las encuentre juntas.
 *
 * ESTO ES PLATA. `resumen_pagos_diarios` ya sumó este movimiento en la caja
 * del día, así que borrarlo la cambia hacia atrás. Por eso la fila entera se
 * copia a `gastosregistros_eliminados` ANTES de desaparecer (script 062): sin
 * eso, la caja de un día cambiaría sin que nadie pueda reconstruir por qué.
 *
 * LAS REGLAS SE VALIDAN DOS VECES, Y NO ES REDUNDANCIA
 * Primero con una lectura, para poder decir POR QUÉ no se pudo. Y después
 * como guardas del propio DELETE, que es lo que atrapa la carrera de que
 * alguien apruebe el movimiento entre la lectura y el borrado.
 */
interface DeleteTransactionParams {
  id: number
  /** Quién borra: queda en el rastro. */
  eliminadoPorId: number | null
  eliminadoPorNombre: string
  motivo?: string
  /**
   * Día Colombia "YYYY-MM-DD" al que debe pertenecer el movimiento. SIEMPRE
   * se exige, incluso a secretaría: editar un movimiento viejo deja la
   * corrección a la vista, borrarlo lo hace desaparecer de la caja de un día
   * ya cerrado.
   */
  fechaColombia: string
  /**
   * Cuando viene, el movimiento además tiene que ser SUYO. Lo manda el
   * asesor; secretaría lo omite, porque supervisa la ruta completa.
   */
  soloDelUsuario?: number
}

/** Estados en los que un movimiento todavía no fue resuelto por nadie. */
const ESTADOS_ABIERTOS = ["NA", "por aprobar"]

/**
 * Las columnas del rastro no están en los tipos generados de Supabase, así
 * que `delete()` e `insert()` resuelven su parámetro a `never`. Se castea
 * igual que hacen `save-transaction.ts` y `edit-transaction.ts`.
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
  delete: () => FiltroSinTipos
  insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>
}

export async function deleteTransaction(params: DeleteTransactionParams) {
  try {
    const supabase = await getSupabaseServer()

    // `*` y no una lista explícita: es la fila entera la que se guarda como
    // rastro, y nombrar columnas haría que esto empiece a perder datos el día
    // que la tabla gane una.
    const { data: actual, error: readErr } = await supabase
      .from("gastosregistros")
      .select("*")
      .eq("id", params.id)
      .maybeSingle()

    if (readErr) {
      console.error("[v0] Error leyendo el movimiento a borrar:", readErr)
      return { success: false, error: readErr.message }
    }
    if (!actual) {
      return { success: false, error: "El movimiento ya no existe" }
    }

    const previo = actual as Record<string, unknown> & {
      estadoadmin: string | null
      estadosecre: string | null
      adminid: number | null
      fechahorasol: string
      ruta: number | null
      tipo: string | null
      valor: number | null
    }

    // ── Las tres reglas ───────────────────────────────────────────────────
    // El orden importa para que el mensaje sea el útil: si es de otro Y de
    // ayer, lo primero que hay que decirle es que no es suyo.
    if (params.soloDelUsuario !== undefined && previo.adminid !== params.soloDelUsuario) {
      return { success: false, error: "Solo puedes eliminar los movimientos que registraste tú" }
    }

    const diaColombia = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(previo.fechahorasol))
    if (diaColombia !== params.fechaColombia) {
      return { success: false, error: "Solo se pueden eliminar los movimientos de hoy" }
    }

    if (
      !ESTADOS_ABIERTOS.includes(previo.estadoadmin ?? "NA") ||
      !ESTADOS_ABIERTOS.includes(previo.estadosecre ?? "NA")
    ) {
      return {
        success: false,
        error: "Este movimiento ya fue aprobado o rechazado: ya no se puede eliminar",
      }
    }

    // ── El rastro VA PRIMERO ──────────────────────────────────────────────
    // Si se borrara antes de copiar y la copia fallara, el movimiento se
    // perdería sin dejar nada. Al revés, lo peor que puede pasar es una fila
    // de rastro sin borrado — visible y corregible.
    const { error: rastroErr } = await (
      supabase.from("gastosregistros_eliminados") as unknown as TablaSinTipos
    ).insert({
      movimiento_id: params.id,
      movimiento: previo,
      ruta: previo.ruta,
      tipo: previo.tipo,
      valor: previo.valor,
      fechahorasol: previo.fechahorasol,
      eliminado_por: params.eliminadoPorId,
      eliminado_por_nombre: params.eliminadoPorNombre,
      motivo: params.motivo?.trim() || null,
    })

    if (rastroErr) {
      console.error("[v0] No se pudo guardar el rastro del borrado:", rastroErr)
      // Se aborta a propósito. Borrar plata sin rastro es peor que no borrar.
      return {
        success: false,
        error: "No se pudo registrar la eliminación. Corre scripts/062 si aún no lo hiciste.",
      }
    }

    // ── Ahora sí, el borrado, con las mismas reglas como guardas ──────────
    let q = (supabase.from("gastosregistros") as unknown as TablaSinTipos)
      .delete()
      .eq("id", params.id)
      .in("estadoadmin", ESTADOS_ABIERTOS)
      .in("estadosecre", ESTADOS_ABIERTOS)

    if (params.soloDelUsuario !== undefined) {
      q = q.eq("adminid", params.soloDelUsuario)
    }

    const { data, error } = await q.select("id")

    if (error) {
      console.error("[v0] Error borrando el movimiento:", error)
      return { success: false, error: error.message }
    }
    if (!data || data.length === 0) {
      return { success: false, error: "Este movimiento acaba de ser resuelto por otra persona" }
    }

    return { success: true, message: "Movimiento eliminado" }
  } catch (error) {
    console.error("[v0] Error in deleteTransaction:", error)
    return { success: false, error: error instanceof Error ? error.message : "Error desconocido" }
  }
}
