"use client"

/**
 * lib/supabase/ensure-session.ts — SHIM
 * ---------------------------------------------------------------------------
 *
 * RLS ha sido eliminado completamente del backend. Las funciones aqui se
 * mantienen como NO-OPS por compatibilidad con los imports existentes, pero
 * ya no llaman `fijar_sesion_usuario` ni interactuan con PgBouncer.
 *
 * El filtrado de datos por ruta/usuario se hace ahora a nivel de aplicacion
 * con `.eq('ruta', rutaId)` o `.eq('ruta_id', rutaId)` en cada consulta.
 *
 * Estas funciones quedan exportadas para que el codigo que aun las importa
 * siga compilando. Devuelven `true` (sesion OK) inmediatamente sin tocar la
 * base. Eliminar este archivo cuando todos los imports hayan sido removidos.
 */

import { createClient } from "@/lib/supabase/client"

/**
 * NO-OP. Antes ejecutaba la RPC `fijar_sesion_usuario`. Ahora retorna true
 * inmediatamente porque RLS fue eliminado y el filtrado es a nivel app.
 */
export async function ensureSession(_force = false): Promise<boolean> {
  return true
}

/**
 * NO-OP. Antes invalidaba el cache de TTL. Ahora no hace nada porque
 * `ensureSession` no tiene cache.
 */
export function invalidateSessionCache(): void {
  // no-op
}

/**
 * Devuelve un cliente Supabase del navegador. Antes garantizaba la sesion
 * antes de devolverlo; ahora simplemente devuelve el cliente.
 */
export async function getSessionScopedClient() {
  return createClient()
}
