"use server"

import { getSupabaseServer } from "@/lib/supabase/server"
import { put } from "@vercel/blob"

interface SaveTransactionParams {
  concepto: string
  limite: number | null
  valor: number
  observacion: string
  foto: string | null
  tipo: "Ingreso" | "Gasto" | "Retiro"
  ruta: number
  adminid: number
  requiresApproval?: boolean
}

export async function saveTransaction(params: SaveTransactionParams) {
  const supabase = await getSupabaseServer()

  try {
    // Timestamp en UTC real — la visualización usa zona Colombia al leer
    const fechahorasol = new Date().toISOString()

    let fotoUrl: string | null = null

    // Upload photo if exists - directly use Vercel Blob
    if (params.foto) {
      try {
        // Convert base64 to Buffer
        const base64Data = params.foto.split(",")[1]
        const buffer = Buffer.from(base64Data, "base64")
        
        const filename = `gastos/${params.tipo.toLowerCase()}_${Date.now()}.jpg`
        
        const blob = await put(filename, buffer, {
          access: "public",
          contentType: "image/jpeg",
        })
        
        fotoUrl = blob.url
        console.log("[v0] Photo uploaded successfully:", fotoUrl)
      } catch (photoError) {
        console.error("[v0] Error processing photo:", photoError)
      }
    }

    // Determine status based on limit and amount
    let estadoadmin: string = "NA"
    let estadosecre: string = "NA"

    if (params.limite && params.valor > params.limite) {
      if (params.requiresApproval) {
        estadoadmin = "por aprobar"
      } else {
        return {
          success: false,
          error: "limit_exceeded",
          requiresApproval: true,
        }
      }
    }

    // Insert transaction record
    const { data, error } = await supabase.from("gastosregistros").insert({
      fechahorasol,
      adminid: params.adminid,
      ruta: params.ruta,
      concepto: params.concepto,
      limite: params.limite,
      valor: params.valor,
      observacion: params.observacion,
      foto: fotoUrl,
      tipo: params.tipo,
      estadoadmin,
      estadosecre,
    })

    if (error) {
      console.error("[v0] Error saving transaction:", error)
      return {
        success: false,
        error: error.message,
      }
    }

    return {
      success: true,
      data,
    }
  } catch (error) {
    console.error("[v0] Error in saveTransaction:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error desconocido",
    }
  }
}
