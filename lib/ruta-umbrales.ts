"use client"

import { createClient } from "@/lib/supabase/client"

export interface RutaUmbrales {
  venta_nueva_habilitado: boolean
  venta_nueva_umbral: number | null
  venta_renovacion_habilitado: boolean
  venta_renovacion_umbral: number | null
  // Umbral de abonos: cantidad de cuotas pagadas de una sola vez (pago
  // normal), NO un monto en pesos.
  abono_habilitado: boolean
  abono_umbral_cuotas: number | null
  // Multas por mora: si el cliente acumula multa_cuotas_umbral cuotas
  // vencidas, se le genera una multa de multa_valor pesos.
  multa_habilitada: boolean
  multa_cuotas_umbral: number | null
  multa_valor: number | null
}

const DEFAULT_UMBRALES: RutaUmbrales = {
  venta_nueva_habilitado: false, venta_nueva_umbral: null,
  venta_renovacion_habilitado: false, venta_renovacion_umbral: null,
  abono_habilitado: false, abono_umbral_cuotas: null,
  multa_habilitada: false, multa_cuotas_umbral: null, multa_valor: null,
}

// Si la ruta no tiene fila configurada, no hay revisión (falla abierta hacia
// "sin revisión" para no bloquear la operación normal si algo sale mal).
export async function getRutaUmbrales(rutaId: number): Promise<RutaUmbrales> {
  try {
    const { data, error } = await createClient()
      .from("ruta_config_umbrales")
      .select("venta_nueva_habilitado, venta_nueva_umbral, venta_renovacion_habilitado, venta_renovacion_umbral, abono_habilitado, abono_umbral_cuotas, multa_habilitada, multa_cuotas_umbral, multa_valor")
      .eq("ruta_id", rutaId)
      .maybeSingle()
    if (error || !data) return DEFAULT_UMBRALES
    return data as RutaUmbrales
  } catch (err) {
    console.error("[v0] Error fetching ruta_config_umbrales:", err)
    return DEFAULT_UMBRALES
  }
}

// Umbral de gasto/ingreso/retiro: se configura por item (concepto especifico
// del catalogo), no como un valor unico compartido por ruta.
export interface ItemUmbral {
  habilitado: boolean
  umbral: number | null
}

export async function getRutaItemUmbrales(rutaId: number): Promise<Map<string, ItemUmbral>> {
  const map = new Map<string, ItemUmbral>()
  try {
    const { data } = await createClient()
      .from("ruta_item_umbrales")
      .select("item_tipo, item_id, habilitado, umbral")
      .eq("ruta_id", rutaId)
    for (const row of (data ?? []) as { item_tipo: string; item_id: number; habilitado: boolean; umbral: number | null }[]) {
      map.set(`${row.item_tipo}:${row.item_id}`, { habilitado: row.habilitado, umbral: row.umbral })
    }
  } catch (err) {
    console.error("[v0] Error fetching ruta_item_umbrales:", err)
  }
  return map
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
