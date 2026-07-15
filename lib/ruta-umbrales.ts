"use client"

import { createClient } from "@/lib/supabase/client"

export interface RutaUmbrales {
  gasto_habilitado: boolean
  gasto_umbral: number | null
  venta_nueva_habilitado: boolean
  venta_nueva_umbral: number | null
  venta_renovacion_habilitado: boolean
  venta_renovacion_umbral: number | null
  abono_habilitado: boolean
  abono_umbral: number | null
}

const DEFAULT_UMBRALES: RutaUmbrales = {
  gasto_habilitado: false, gasto_umbral: null,
  venta_nueva_habilitado: false, venta_nueva_umbral: null,
  venta_renovacion_habilitado: false, venta_renovacion_umbral: null,
  abono_habilitado: false, abono_umbral: null,
}

// Si la ruta no tiene fila configurada, no hay revisión (falla abierta hacia
// "sin revisión" para no bloquear la operación normal si algo sale mal).
export async function getRutaUmbrales(rutaId: number): Promise<RutaUmbrales> {
  try {
    const { data, error } = await createClient()
      .from("ruta_config_umbrales")
      .select("gasto_habilitado, gasto_umbral, venta_nueva_habilitado, venta_nueva_umbral, venta_renovacion_habilitado, venta_renovacion_umbral, abono_habilitado, abono_umbral")
      .eq("ruta_id", rutaId)
      .maybeSingle()
    if (error || !data) return DEFAULT_UMBRALES
    return data as RutaUmbrales
  } catch (err) {
    console.error("[v0] Error fetching ruta_config_umbrales:", err)
    return DEFAULT_UMBRALES
  }
}

export function excedeUmbral(habilitado: boolean, umbral: number | null, monto: number): boolean {
  return habilitado && umbral !== null && monto > umbral
}

export const MENSAJE_REVISION = "Este movimiento pasará a revisión de la secretaria"

export function getSolicitanteNombre(): string | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem("currentUser")
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.nombre ?? null
  } catch {
    return null
  }
}
