"use client"

/**
 * lib/jornada-pendiente.ts
 * ---------------------------------------------------------------------------
 * La jornada de un día anterior que quedó sin cerrar.
 *
 * QUÉ PROBLEMA RESUELVE
 * Hasta ahora, a las 12 de la noche el día simplemente se acababa: al otro día
 * `rutas_diarias` no tenía fila, salía "Iniciar ruta" y a nadie le constaba que
 * la caja del día anterior nunca se cuadró. La fila vieja se quedaba 'abierta'
 * para siempre y no volvía a estorbar. Medido el 01/09/2026: 43 jornadas así,
 * repartidas en 8 rutas.
 *
 * Ahora la ruta amanece CONGELADA. No se puede empezar el día nuevo mientras
 * quede uno viejo sin cerrar, y quien tiene permiso lo desbloquea dejando
 * constancia de quién fue.
 *
 * POR QUÉ SE ENCIENDE SOLO CUANDO EL SCRIPT 086 YA CORRIÓ
 * `buscarJornadaPendiente` pide la columna `cerrada_sin_cuadre`, que crea ese
 * script. Si no existe todavía, PostgREST responde 42703 y acá se devuelve
 * `null`: sin congelamiento.
 *
 * No es un truco: es la única secuencia segura. El script hace dos cosas —crea
 * la columna y cierra las 43 jornadas viejas— y si el congelamiento entrara en
 * vigor antes, las 8 rutas amanecerían bloqueadas y la ruta 1 tendría que
 * resolver 15 días viejos antes de cobrar un peso. Atando la función a la
 * columna, el orden no se puede invertir aunque el despliegue llegue primero.
 */

import { getSupabaseSafe } from "@/lib/api-helper"
import { todayColombia } from "@/lib/colombia-date"

export interface JornadaPendiente {
  id: number
  fecha: string
}

/**
 * Quién puede descongelar una ruta.
 *
 * Va por lista de quién SÍ, igual que `ROLES_CON_PIN`: con la lista invertida,
 * un rol nuevo podría descongelar sin que nadie lo hubiera decidido.
 */
export const ROLES_QUE_DESCONGELAN = [
  "secretaria", "secretario", "admin", "administrador", "gerencia",
] as const

export function puedeDescongelar(rol: string | null | undefined): boolean {
  const r = (rol ?? "").toLowerCase().trim()
  return (ROLES_QUE_DESCONGELAN as readonly string[]).includes(r)
}

/**
 * La jornada más vieja de esta ruta que quedó abierta en un día pasado.
 *
 * Devuelve la MÁS VIEJA y no la más reciente: si hay varias, hay que ir
 * resolviéndolas en orden, y mostrar la última dejaría las anteriores
 * escondidas detrás.
 *
 * Nunca lanza. Un error de red no puede congelar una ruta: si no se pudo
 * preguntar, se devuelve `null` y el día sigue como siempre. El lado seguro
 * del error acá es dejar trabajar, no bloquear a alguien en la calle por una
 * consulta que falló.
 */
export async function buscarJornadaPendiente(rutaId: number): Promise<JornadaPendiente | null> {
  try {
    const supabase = await getSupabaseSafe()
    const { data, error } = await supabase
      .from("rutas_diarias")
      .select("id, fecha, cerrada_sin_cuadre")
      .eq("ruta_id", rutaId)
      .eq("estado", "abierta")
      .lt("fecha", todayColombia())
      .order("fecha", { ascending: true })
      .limit(1)
      .maybeSingle()

    if (error) {
      // 42703 = la columna no existe: el script 086 todavía no corrió y el
      // congelamiento no debe estar en vigor. Cualquier otro error tampoco
      // justifica bloquear.
      if ((error as { code?: string }).code !== "42703") {
        console.error("[v0] buscarJornadaPendiente error:", error.message)
      }
      return null
    }
    if (!data) return null
    const d = data as unknown as { id: number; fecha: string }
    return { id: d.id, fecha: d.fecha }
  } catch (err) {
    console.error("[v0] buscarJornadaPendiente falló:", err)
    return null
  }
}

/**
 * Cerrar una jornada vieja para descongelar la ruta.
 *
 * NO inventa un cuadre: `hora_fin` se queda en NULL y `cerrada_sin_cuadre`
 * queda en true, igual que hace el script 086. La diferencia es que acá queda
 * escrito QUIÉN la cerró y cuándo, que es lo que se le pide a una persona que
 * está usando su permiso.
 */
export async function descongelarJornada(
  jornadaId: number,
  quien: { id: number | string; nombre: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = await getSupabaseSafe()
    const ahora = new Date().toISOString()
    const { error } = await supabase
      .from("rutas_diarias")
      .update({
        estado: "cerrada",
        cerrada_sin_cuadre: true,
        observacion:
          `Descongelada por ${quien.nombre} (usuario ${quien.id}) el ${ahora}. ` +
          `La jornada quedó sin cierre de caja y se cerró para poder seguir trabajando.`,
      })
      .eq("id", jornadaId)
      .eq("estado", "abierta")

    if (error) {
      console.error("[v0] descongelarJornada error:", error.message)
      return { ok: false, error: "No se pudo desbloquear la ruta. Revisa la conexión." }
    }
    return { ok: true }
  } catch (err) {
    console.error("[v0] descongelarJornada falló:", err)
    return { ok: false, error: "No se pudo desbloquear la ruta." }
  }
}
