"use server"

import { getSupabaseServer } from "@/lib/supabase/server"

interface ApproveTransactionParams {
  id: number
  status: "aprobado" | "rechazado"
  adminName: string
}

export async function approveTransaction(params: ApproveTransactionParams) {
  try {
    const supabase = await getSupabaseServer()

    const fechahoraaproboadm = new Date().toISOString()

    // El `.eq("estadoadmin", "por aprobar")` es la guarda: sin el, una
    // pantalla vieja podia volver a aprobar (o voltear a rechazado) algo que
    // otra persona ya habia resuelto.
    if (params.status === "aprobado") {
      // Si el movimiento ya venia aprobado por secretaria desde la cola de
      // Movimientos en Revision, no se le vuelve a pedir: se cierra directo.
      // La firma de secretaria se detecta por `secretariaaprobo` y no por
      // `estadosecre`, porque ese se deja en 'NA' a proposito mientras el
      // admin no firme (si no, la vista resumen_pagos_diarios ya lo estaria
      // sumando como plata autorizada).
      const { data: actual, error: readErr } = await supabase
        .from("gastosregistros")
        .select("secretariaaprobo")
        .eq("id", params.id)
        .maybeSingle()
      if (readErr) {
        console.error("[v0] Error leyendo la transaccion:", readErr)
        return { success: false, error: readErr.message }
      }
      const yaAprobadaPorSecretaria = !!(actual as { secretariaaprobo?: string | null } | null)?.secretariaaprobo

      const { data, error } = await supabase.from("gastosregistros").update({
        estadoadmin: "aprobado",
        estadosecre: yaAprobadaPorSecretaria ? "aprobado" : "por aprobar",
        adminaprobo: params.adminName,
        fechahoraaproboadm,
      }).eq("id", params.id).eq("estadoadmin", "por aprobar").select("id")

      if (error) {
        console.error("[v0] Error approving transaction:", error)
        return { success: false, error: error.message }
      }
      if (!data || data.length === 0) {
        return { success: false, error: "Este movimiento ya fue resuelto por otra persona" }
      }

      return { success: true, message: "Transacción aprobada exitosamente" }
    } else if (params.status === "rechazado") {
      const { data, error } = await supabase.from("gastosregistros").update({
        estadoadmin: "rechazado",
        adminaprobo: params.adminName,
        fechahoraaproboadm,
      }).eq("id", params.id).eq("estadoadmin", "por aprobar").select("id")

      if (error) {
        console.error("[v0] Error rejecting transaction:", error)
        return { success: false, error: error.message }
      }
      if (!data || data.length === 0) {
        return { success: false, error: "Este movimiento ya fue resuelto por otra persona" }
      }

      return { success: true, message: "Transacción rechazada exitosamente" }
    }

    return { success: false, error: "Estado no válido" }
  } catch (error) {
    console.error("[v0] Error in approveTransaction:", error)
    return { success: false, error: error instanceof Error ? error.message : "Error desconocido" }
  }
}
