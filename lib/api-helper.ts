"use client"

/**
 * lib/api-helper.ts
 * ---------------------------------------------------------------------------
 *
 * Helpers centralizados de Supabase del lado cliente.
 *
 * CAMBIO ARQUITECTONICO (mayo 2026): RLS eliminado de la base.
 * --------------------------------------------------------------
 * El filtrado por ruta/usuario ahora es 100% responsabilidad de la
 * aplicacion. Cada consulta debe agregar `.eq('ruta', rutaId)` (o
 * `.eq('ruta_id', rutaId)` para `rutas_diarias` y `vista_monitoreo_admin`).
 *
 * Lo que CAMBIO en este archivo:
 *   - `safeQuery` y `getSupabaseSafe` son ahora atajos delgados que solo
 *     devuelven `createClient()`. Conservan la misma firma para que los
 *     imports existentes sigan funcionando, pero ya NO llaman ensureSession.
 *   - `runReadWithRLSRetry` y `runWritesWithRLSRetry` ya NO hacen retry de
 *     "RLS warmup". Son pass-throughs: ejecutan el factory una vez y
 *     devuelven el resultado.
 *
 * Lo que SE MANTIENE:
 *   - `getSessionIdentity` + `callRpcAtomic`: las RPCs de ESCRITURA atomicas
 *     (`registrar_pago_atomico`, `crear_venta_atomica`, etc.) siguen siendo
 *     utiles para integridad transaccional. Reciben user/ruta/rol como
 *     argumentos del payload pero NO bloquean por RLS internamente.
 *   - `SessionLostError` + `notifySessionLost`: validar presencia de
 *     usuario y ruta en localStorage sigue siendo importante para evitar
 *     queries sin filtro.
 */

import { createClient } from "@/lib/supabase/client"
import type { SupabaseClient } from "@supabase/supabase-js"

export const SESSION_LOST_EVENT = "app:session-lost"

export class SessionLostError extends Error {
  constructor(message = "Sesion perdida. Se requiere iniciar sesion nuevamente.") {
    super(message)
    this.name = "SessionLostError"
  }
}

/**
 * Dispara el evento global que el layout principal escucha para redirigir
 * al usuario al flujo de login/seleccion de ruta. Es idempotente.
 */
export function notifySessionLost(reason: string): void {
  if (typeof window === "undefined") return
  console.warn("[v0] Session lost:", reason)
  window.dispatchEvent(
    new CustomEvent(SESSION_LOST_EVENT, { detail: { reason } }),
  )
}

interface SafeQueryOptions {
  /** Conservado por compatibilidad. Ignorado. */
  forceSession?: boolean
}

/**
 * Envuelve una operacion de Supabase. Tras la eliminacion de RLS ya NO
 * fija session vars; solo valida que haya usuario y ruta en localStorage
 * (sin eso, las queries no podrian filtrar por ruta correctamente) y
 * devuelve el cliente. Si falta la sesion, dispara el evento de logout
 * global y lanza `SessionLostError`.
 */
export async function safeQuery<T>(
  operation: (supabase: SupabaseClient) => Promise<T>,
  _options: SafeQueryOptions = {},
): Promise<T> {
  if (typeof window === "undefined") {
    throw new SessionLostError("safeQuery solo puede usarse en el cliente")
  }
  let hasUser = false
  let hasRuta = false
  try {
    hasUser = !!localStorage.getItem("currentUser")
    hasRuta = !!localStorage.getItem("selectedRuta")
  } catch {
    // localStorage bloqueado (Safari privado, etc.)
  }
  if (!hasUser || !hasRuta) {
    notifySessionLost(
      !hasUser ? "missing-user-in-localStorage" : "missing-ruta-in-localStorage",
    )
    throw new SessionLostError(
      "No hay sesion activa. Inicia sesion y selecciona una ruta.",
    )
  }
  const supabase = createClient()
  return operation(supabase)
}

/**
 * Atajo para obtener un cliente Supabase listo para usar. Antes garantizaba
 * la sesion en la base; ahora solo valida localStorage y devuelve el client.
 */
export async function getSupabaseSafe(
  options: SafeQueryOptions = {},
): Promise<SupabaseClient> {
  return safeQuery(async (supabase) => supabase, options)
}

// ============================================================================
// getSessionIdentity — lee user_id / ruta_id / rol desde localStorage.
// ============================================================================

/**
 * Identidad de sesion necesaria para llamar las funciones RPC atomicas de
 * escritura (`registrar_pago_atomico`, `crear_venta_atomica`, etc.).
 */
export interface SessionIdentity {
  user_id: number
  ruta_id: number
  rol: string | null
}

/**
 * Lee la identidad de sesion desde localStorage. Si falta algun dato dispara
 * `app:session-lost` y lanza `SessionLostError`.
 */
export function getSessionIdentity(): SessionIdentity {
  if (typeof window === "undefined") {
    throw new SessionLostError("getSessionIdentity solo puede usarse en el cliente")
  }
  let rawUser: string | null = null
  let rawRuta: string | null = null
  try {
    rawUser = localStorage.getItem("currentUser")
    rawRuta = localStorage.getItem("selectedRuta")
  } catch {
    // localStorage bloqueado
  }
  if (!rawUser || !rawRuta) {
    notifySessionLost(
      !rawUser ? "missing-user-in-localStorage" : "missing-ruta-in-localStorage",
    )
    throw new SessionLostError("No hay sesion activa.")
  }
  try {
    const user = JSON.parse(rawUser) as { id: number | string; rol?: string | null }
    const ruta = JSON.parse(rawRuta) as { id: number | string }
    const userId = Number(user.id)
    const rutaId = Number(ruta.id)
    if (!userId || !rutaId) {
      throw new Error("user.id o ruta.id invalidos")
    }
    return { user_id: userId, ruta_id: rutaId, rol: user.rol ?? null }
  } catch (err) {
    notifySessionLost(
      `localStorage-parse-error: ${err instanceof Error ? err.message : String(err)}`,
    )
    throw new SessionLostError("Datos de sesion corruptos en localStorage.")
  }
}

// ============================================================================
// callRpcAtomic — RPC de escritura atomica (mantiene integridad transaccional)
// ============================================================================

export interface AtomicRpcResult {
  ok: boolean
  cuotas_actualizadas?: number
  nuevo_saldo?: number
  loan_estado_final?: "activo" | "cancelado"
  cliente_marcado_sin_prestamo?: boolean
  [key: string]: unknown
}

/**
 * Llama una funcion RPC atomica de escritura. Mantiene la firma estandar
 * (p_user_id, p_ruta_id, p_rol, p_payload) que las RPCs ya usan internamente
 * para integridad transaccional. RLS ya no bloquea, pero los parametros se
 * conservan en el payload para auditoria y validacion dentro de cada
 * funcion.
 *
 * Reintenta hasta 3 veces ante errores transitorios de red.
 */
export async function callRpcAtomic<T extends AtomicRpcResult = AtomicRpcResult>(
  functionName: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const identity = getSessionIdentity()
  const supabase = createClient()

  const MAX_ATTEMPTS = 3
  let lastErrorMsg = ""
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { data, error } = await supabase.rpc(functionName, {
        p_user_id: identity.user_id,
        p_ruta_id: identity.ruta_id,
        p_rol: identity.rol,
        p_payload: payload,
      })
      if (!error) {
        return (data ?? { ok: true }) as T
      }
      lastErrorMsg = error.message ?? String(error)
      const isNetworkError =
        lastErrorMsg.includes("NetworkError") ||
        lastErrorMsg.includes("Failed to fetch") ||
        lastErrorMsg.includes("TypeError")
      if (!isNetworkError) {
        throw new Error(lastErrorMsg)
      }
      console.warn(
        `[v0] callRpcAtomic(${functionName}) network error ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS}):`,
        lastErrorMsg,
      )
    } catch (err) {
      lastErrorMsg = err instanceof Error ? err.message : String(err)
      const isNetworkError =
        lastErrorMsg.includes("NetworkError") ||
        lastErrorMsg.includes("Failed to fetch") ||
        lastErrorMsg.includes("TypeError")
      if (!isNetworkError) {
        throw err instanceof Error ? err : new Error(lastErrorMsg)
      }
      console.warn(
        `[v0] callRpcAtomic(${functionName}) threw (attempt ${attempt}/${MAX_ATTEMPTS}):`,
        lastErrorMsg,
      )
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt === 1 ? 200 : 500))
    }
  }
  throw new Error(
    `${functionName} fallo tras ${MAX_ATTEMPTS} intentos: ${lastErrorMsg}`,
  )
}

// ============================================================================
// runReadWithRLSRetry / runWritesWithRLSRetry — PASS-THROUGHS
// ============================================================================
//
// Mantenidos como pass-throughs por compatibilidad con callers existentes.
// Despues de eliminar RLS no tiene sentido el retry; ejecutamos el factory
// una sola vez y devolvemos el resultado. Cuando todos los callers hayan
// migrado a queries directas, estos exports pueden eliminarse.

export interface SbReadResult<T> {
  data: T | null
  error: { message: string } | null
}

export async function runReadWithRLSRetry<T>(
  label: string,
  factory: () => PromiseLike<SbReadResult<T>>,
  _maxAttempts = 3,
): Promise<T> {
  const { data, error } = await factory()
  if (error) {
    throw new Error(`${label}: ${error.message ?? "unknown error"}`)
  }
  return (data as T) ?? ([] as unknown as T)
}

export interface SbWriteResult {
  data: unknown[] | null
  error: { message: string } | null
}

export interface WriteItem {
  label: string
  factory: () => PromiseLike<SbWriteResult>
}

export async function runWritesWithRLSRetry(
  items: WriteItem[],
  _maxAttempts = 4,
): Promise<void> {
  if (items.length === 0) return
  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const r = await item.factory()
        return { item, result: r, threw: null as Error | null }
      } catch (err) {
        return {
          item,
          result: { data: null, error: null } as SbWriteResult,
          threw: err instanceof Error ? err : new Error(String(err)),
        }
      }
    }),
  )
  const threwOne = results.find((r) => r.threw)
  if (threwOne) {
    throw new Error(`${threwOne.item.label}: ${threwOne.threw!.message}`)
  }
  const errored = results.find((r) => r.result.error)
  if (errored) {
    throw new Error(
      `${errored.item.label}: ${errored.result.error!.message ?? "unknown"}`,
    )
  }
}
