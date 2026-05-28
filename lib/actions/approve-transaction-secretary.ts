"use server"

import { getSupabaseServer } from "@/lib/supabase/server"

interface ApproveTransactionSecretaryParams {
  id: number
  status: "aprobado" | "rechazado"
  secretaryName: string
}

export async function approveTransactionSecretary(
  params: ApproveTransactionSecretaryParams
) {
  try {
    const supabase = await getSupabaseServer()

    const fechahoraaprobosecretaria = new Date().toISOString()

    if (params.status === "aprobado") {
      const { error } = await supabase
        .from("gastosregistros")
        .update({
          estadosecre: "aprobado",
          secretariaaprobo: params.secretaryName,
          fechahoraaprobosecretaria,
        })
        .eq("id", params.id)

      if (error) {
        console.error("[v0] Error approving transaction:", error)
        return { success: false, error: error.message }
      }

      return { success: true, message: "Transacción aprobada exitosamente" }
    } else if (params.status === "rechazado") {
      const { error } = await supabase
        .from("gastosregistros")
        .update({
          estadosecre: "rechazado",
          secretariaaprobo: params.secretaryName,
          fechahoraaprobosecretaria,
        })
        .eq("id", params.id)

      if (error) {
        console.error("[v0] Error rejecting transaction:", error)
        return { success: false, error: error.message }
      }

      return { success: true, message: "Transacción rechazada exitosamente" }
    }

    return { success: false, error: "Estado no válido" }
  } catch (error) {
    console.error("[v0] Error in approveTransactionSecretary:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error desconocido",
    }
  }
}
