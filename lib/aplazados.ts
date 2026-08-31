"use client"

/**
 * lib/aplazados.ts
 * ---------------------------------------------------------------------------
 * Clientes que hoy quedaron "para después".
 *
 * QUÉ ES UN APLAZADO
 * Ni pago ni no pago: no pasó nada todavía. El cobrador pasó, no pudo cobrar
 * —el local cerrado, el cliente no estaba, dijo que volviera más tarde— y
 * tiene que volver. Hasta ahora eso no existía: había que marcar no pago (que
 * es una visita fallida, y no lo fue) o dejarlo en la ruta y acordarse.
 *
 * Sale de la pestaña "Ruta" y entra en "Pendientes", de donde después pasa a
 * pago o a no pago como cualquier otro.
 *
 * POR QUÉ NO VA AL LIBRO DE EVENTOS
 * `gestiones` es el libro de la PLATA, y un aplazado no mueve un peso. Meterlo
 * ahí obligaba a un tipo nuevo en el CHECK de la tabla y a que las siete
 * vistas derivadas supieran ignorarlo — riesgo sobre el núcleo a cambio de
 * nada. Y para las cuentas del día un aplazado es exactamente lo que ya era:
 * un cliente sin gestionar. El Monitoreo lo sigue contando como pendiente por
 * visitar, que es la verdad.
 *
 * POR QUÉ VIVE EN EL TELÉFONO Y NO EN EL SERVIDOR
 * Es la libreta del cobrador sobre su propio día, y se marca en la calle,
 * muchas veces sin señal. Guardarlo en el aparato funciona sin conexión y sin
 * un solo script que correr.
 *
 * Lo que se pierde si el teléfono se recarga o se cambia: las marcas. El
 * cliente vuelve a aparecer en "Ruta". Es el lado seguro del error — reaparece
 * donde igual hay que cobrarle, no desaparece.
 *
 * SE BORRAN SOLAS AL CAMBIAR EL DÍA
 * Un aplazado es de HOY. Sin la fecha en la llave, el cliente que se aplazó el
 * martes seguiría escondido de la ruta el miércoles.
 */

import { todayColombia } from "@/lib/colombia-date"

const PREFIJO = "aplazados"

function clave(rutaId: number): string {
  return `${PREFIJO}_${rutaId}_${todayColombia()}`
}

/** Los créditos aplazados hoy en esta ruta. */
export function leerAplazados(rutaId: number): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = localStorage.getItem(clave(rutaId))
    if (!raw) return new Set()
    const ids = JSON.parse(raw) as unknown
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

function guardar(rutaId: number, ids: Set<string>): void {
  if (typeof window === "undefined") return
  try {
    if (ids.size === 0) localStorage.removeItem(clave(rutaId))
    else localStorage.setItem(clave(rutaId), JSON.stringify([...ids]))
    limpiarViejos()
  } catch (err) {
    console.warn("[v0] No se pudieron guardar los aplazados:", err)
  }
}

export function aplazar(rutaId: number, loanId: string): Set<string> {
  const ids = leerAplazados(rutaId)
  ids.add(loanId)
  guardar(rutaId, ids)
  return ids
}

export function quitarAplazado(rutaId: number, loanId: string): Set<string> {
  const ids = leerAplazados(rutaId)
  ids.delete(loanId)
  guardar(rutaId, ids)
  return ids
}

/**
 * Barrer las marcas de días anteriores.
 *
 * La llave lleva la fecha, así que las viejas ya no se leen — pero sí se
 * quedan ocupando `localStorage`, y una ruta de cuarenta clientes por
 * trescientos días llena la cuota y hace fallar escrituras que sí importan.
 * Se limpia al guardar, que es cuando ya se está tocando el almacenamiento.
 */
function limpiarViejos(): void {
  const hoy = todayColombia()
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(`${PREFIJO}_`)) continue
      // Se borra por FECHA, no por "toda llave que no sea la mía". Una
      // secretaría que mira dos rutas el mismo día tiene una marca por cada
      // una, y guardar la de una borraría la de la otra.
      if (!k.endsWith(`_${hoy}`)) localStorage.removeItem(k)
    }
  } catch {
    /* modo privado */
  }
}
