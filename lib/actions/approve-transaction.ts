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

    if (params.status === "aprobado") {
      const { error } = await supabase.from("gastosregistros").update({
        estadoadmin: "aprobado",
        estadosecre: "por aprobar",
        adminaprobo: params.adminName,
        fechahoraaproboadm,
      }).eq("id", params.id)

      if (error) {
        console.error("[v0] Error approving transaction:", error)
        return { success: false, error: error.message }
      }

      return { success: true, message: "Transacción aprobada exitosamente" }
    } else if (params.status === "rechazado") {
      const { error } = await supabase.from("gastosregistros").update({
        estadoadmin: "rechazado",
        adminaprobo: params.adminName,
        fechahoraaproboadm,
      }).eq("id", params.id)

      if (error) {
        console.error("[v0] Error rejecting transaction:", error)
        return { success: false, error: error.message }
      }

      return { success: true, message: "Transacción rechazada exitosamente" }
    }

    return { success: false, error: "Estado no válido" }
  } catch (error) {
    console.error("[v0] Error in approveTransaction:", error)
    return { success: false, error: error instanceof Error ? error.message : "Error desconocido" }
  }
}
