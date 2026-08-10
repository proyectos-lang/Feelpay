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
  // vencidas, se le genera una multa. El valor de esa multa se calcula
  // segun multa_tipo_valor: 'fijo' usa multa_valor en pesos directamente,
  // 'cuotas' multiplica multa_cantidad_cuotas por el valor de una cuota
  // del prestamo (multiplicador fijo, no escala con cuotas vencidas).
  multa_habilitada: boolean
  multa_cuotas_umbral: number | null
  multa_tipo_valor: "fijo" | "cuotas"
  multa_valor: number | null
  multa_cantidad_cuotas: number | null
  // Logo propio de la ruta para el recibo. null = se usa el de la app.
  logo_url: string | null
}

const DEFAULT_UMBRALES: RutaUmbrales = {
  venta_nueva_habilitado: false, venta_nueva_umbral: null,
  venta_renovacion_habilitado: false, venta_renovacion_umbral: null,
  abono_habilitado: false, abono_umbral_cuotas: null,
  multa_habilitada: false, multa_cuotas_umbral: null,
  multa_tipo_valor: "fijo", multa_valor: null, multa_cantidad_cuotas: null,
  logo_url: null,
}

// Cache local de los umbrales por ruta.
//
// Sin conexion la consulta falla y se caeria a DEFAULT_UMBRALES (todo
// deshabilitado), lo que significa "ninguna operacion necesita revision" — y
// una venta grande registrada offline se aplicaria directo en vez de pasar
// por secretaria. Guardando el ultimo valor leido, la decision offline es la
// misma que se habria tomado con senal.
const UMBRALES_CACHE_KEY = "ruta_umbrales_cache"

function leerCache(rutaId: number): RutaUmbrales | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(`${UMBRALES_CACHE_KEY}_${rutaId}`)
    return raw ? (JSON.parse(raw) as RutaUmbrales) : null
  } catch {
    return null
  }
}

function guardarCache(rutaId: number, u: RutaUmbrales): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(`${UMBRALES_CACHE_KEY}_${rutaId}`, JSON.stringify(u))
  } catch {
    /* cuota de almacenamiento llena o modo privado: no es critico */
  }
}

// Si la ruta no tiene fila configurada, no hay revisión (falla abierta hacia
// "sin revisión" para no bloquear la operación normal si algo sale mal).
export async function getRutaUmbrales(rutaId: number): Promise<RutaUmbrales> {
  try {
    const { data, error } = await createClient()
      .from("ruta_config_umbrales")
      .select("venta_nueva_habilitado, venta_nueva_umbral, venta_renovacion_habilitado, venta_renovacion_umbral, abono_habilitado, abono_umbral_cuotas, multa_habilitada, multa_cuotas_umbral, multa_tipo_valor, multa_valor, multa_cantidad_cuotas, logo_url")
      .eq("ruta_id", rutaId)
      .maybeSingle()
    if (error) return leerCache(rutaId) ?? DEFAULT_UMBRALES
    if (!data) return DEFAULT_UMBRALES
    const umbrales = data as RutaUmbrales
    guardarCache(rutaId, umbrales)
    return umbrales
  } catch (err) {
    console.error("[v0] Error fetching ruta_config_umbrales:", err)
    return leerCache(rutaId) ?? DEFAULT_UMBRALES
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
