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
  /**
   * Llave generada en el dispositivo. Si la peticion se reintenta (o se
   * sincroniza dos veces desde la cola offline), la segunda vez no inserta
   * nada y devuelve el resultado original. Sin esto, un reintento por mala
   * senal duplicaba el movimiento de caja.
   */
  idempotencyKey?: string
  /**
   * Momento real de captura en el dispositivo (ISO). Necesario para la cola
   * offline: sin esto un gasto registrado a las 3pm sin senal quedaria con la
   * hora en que se sincronizo, cayendo en el dia equivocado.
   */
  fechaCaptura?: string
}

export async function saveTransaction(params: SaveTransactionParams) {
  const supabase = await getSupabaseServer()

  try {
    // Hora de captura en el dispositivo; si no viene, ahora (comportamiento
    // anterior). La visualizacion usa zona Colombia al leer.
    const fechahorasol = params.fechaCaptura ?? new Date().toISOString()

    // ── Idempotencia ──────────────────────────────────────────────────
    if (params.idempotencyKey) {
      const { data: previa } = await supabase
        .from("operaciones_procesadas")
        .select("resultado")
        .eq("id", params.idempotencyKey)
        .maybeSingle()
      if (previa) {
        return { success: true, data: null, duplicado: true }
      }
    }

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

    // Marcar la operacion como procesada para que un reintento no la duplique.
    // El cast es necesario porque los tipos generados de Supabase todavia no
    // incluyen esta tabla (creada en scripts/030).
    if (params.idempotencyKey) {
      await (supabase.from("operaciones_procesadas") as unknown as {
        insert: (row: Record<string, unknown>) => Promise<unknown>
      }).insert({
        id: params.idempotencyKey,
        tipo: `transaccion_${params.tipo.toLowerCase()}`,
        user_id: params.adminid,
        ruta_id: params.ruta,
        resultado: { ok: true },
      })
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
