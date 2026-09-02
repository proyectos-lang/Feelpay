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
  /**
   * LA SECRETARÍA YA ABRIÓ LA PUERTA.
   *
   * `false` = congelada de verdad: el cobrador no puede hacer nada.
   * `true`  = habilitada: el cobrador ve el día viejo y hace SU cierre.
   *
   * Siempre `false` mientras el script 096 no haya corrido, porque la columna
   * que lo dice no existe. Eso deja el comportamiento viejo intacto en vez de
   * habilitar a todo el mundo por accidente.
   */
  desbloqueada: boolean
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
    const pedir = (columnas: string) =>
      supabase
        .from("rutas_diarias")
        .select(columnas)
        .eq("ruta_id", rutaId)
        .eq("estado", "abierta")
        .lt("fecha", todayColombia())
        .order("fecha", { ascending: true })
        .limit(1)
        .maybeSingle()

    let { data, error } = await pedir("id, fecha, cerrada_sin_cuadre, desbloqueada_at")

    // 42703 = falta alguna columna. Puede ser `desbloqueada_at` (script 096
    // pendiente) o `cerrada_sin_cuadre` (script 086 pendiente), y no son lo
    // mismo: sin la del 086 el congelamiento NO debe estar en vigor, y sin la
    // del 096 sí pero sin poder habilitar a nadie. Se reintenta pidiendo solo
    // la del 086 para distinguir los dos casos.
    let hayDesbloqueo = true
    if (error && (error as { code?: string }).code === "42703") {
      hayDesbloqueo = false
      ;({ data, error } = await pedir("id, fecha, cerrada_sin_cuadre"))
    }

    if (error) {
      // Sigue faltando `cerrada_sin_cuadre`: el 086 no corrió y el
      // congelamiento no debe estar en vigor. Cualquier otro error tampoco
      // justifica bloquear.
      if ((error as { code?: string }).code !== "42703") {
        console.error("[v0] buscarJornadaPendiente error:", error.message)
      }
      return null
    }
    if (!data) return null
    const d = data as unknown as { id: number; fecha: string; desbloqueada_at?: string | null }
    return {
      id: d.id,
      fecha: d.fecha,
      desbloqueada: hayDesbloqueo && !!d.desbloqueada_at,
    }
  } catch (err) {
    console.error("[v0] buscarJornadaPendiente falló:", err)
    return null
  }
}

/**
 * HABILITAR AL COBRADOR PARA QUE CIERRE ÉL.
 *
 * Es lo que hace hoy el botón de la secretaría, y NO cierra la jornada: la
 * deja abierta y marcada. El cobrador entonces ve el día viejo en su teléfono
 * con el botón para hacer su cierre, y ese cierre sí lleva los números.
 *
 * POR QUÉ NO LO CIERRA ELLA. Porque el que tiene la plata contada en la mano
 * es el cobrador. Cerrar desde el escritorio dejaba ese día sin cuadre para
 * siempre: la ruta se liberaba, pero la jornada nunca tuvo cierre.
 *
 * SI EL SCRIPT 096 NO CORRIÓ TODAVÍA, la columna no existe y esto se cae al
 * comportamiento de antes —cerrar sin cuadre— en vez de dejar a la secretaría
 * sin poder desbloquear nada. Se avisa por consola cuál de los dos pasó.
 */
export async function habilitarCierreAtrasado(
  jornadaId: number,
  quien: { id: number | string; nombre: string },
): Promise<{ ok: boolean; error?: string; modo: "habilitada" | "cerrada_sin_cuadre" }> {
  try {
    const supabase = await getSupabaseSafe()
    const { error } = await supabase
      .from("rutas_diarias")
      .update({
        desbloqueada_at: new Date().toISOString(),
        desbloqueada_por_nombre: quien.nombre,
      })
      .eq("id", jornadaId)
      .eq("estado", "abierta")

    if (!error) return { ok: true, modo: "habilitada" }

    if ((error as { code?: string }).code === "42703") {
      console.warn("[v0] rutas_diarias sin las columnas del script 096; cerrando sin cuadre")
      const r = await descongelarJornada(jornadaId, quien)
      return { ...r, modo: "cerrada_sin_cuadre" }
    }

    console.error("[v0] habilitarCierreAtrasado error:", error.message)
    return { ok: false, error: "No se pudo habilitar la ruta. Revisa la conexión.", modo: "habilitada" }
  } catch (err) {
    console.error("[v0] habilitarCierreAtrasado falló:", err)
    return { ok: false, error: "No se pudo habilitar la ruta.", modo: "habilitada" }
  }
}

/**
 * Cerrar una jornada vieja SIN CUADRARLA. La salida de emergencia.
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
