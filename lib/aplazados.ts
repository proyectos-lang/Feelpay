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

/**
 * Los créditos aplazados hoy en esta ruta, con LA HORA en que se aplazaron.
 *
 * La hora existe porque el aplazado también sale en la pestaña de Gestionados,
 * y ahí cada tarjeta dice a qué hora pasó lo que pasó. Sin ella, la del
 * aplazado sería la única sin hora en una lista donde todas la tienen.
 *
 * SE LEEN LAS DOS FORMAS. La primera versión guardaba un array de ids a secas.
 * Un teléfono que aplazó clientes esta mañana tiene ese formato en disco, y
 * descartarlo le devolvería los clientes a la ruta a media jornada.
 */
export function leerAplazados(rutaId: number): Map<string, string> {
  const m = new Map<string, string>()
  if (typeof window === "undefined") return m
  try {
    const raw = localStorage.getItem(clave(rutaId))
    if (!raw) return m
    const dato = JSON.parse(raw) as unknown
    if (Array.isArray(dato)) {
      // Formato viejo: solo ids. Se conservan, sin hora.
      for (const id of dato) if (typeof id === "string") m.set(id, "")
    } else if (dato && typeof dato === "object") {
      for (const [id, hora] of Object.entries(dato as Record<string, unknown>)) {
        m.set(id, typeof hora === "string" ? hora : "")
      }
    }
  } catch {
    /* dato corrupto: se empieza de cero */
  }
  return m
}

function guardar(rutaId: number, m: Map<string, string>): void {
  if (typeof window === "undefined") return
  try {
    if (m.size === 0) localStorage.removeItem(clave(rutaId))
    else localStorage.setItem(clave(rutaId), JSON.stringify(Object.fromEntries(m)))
    limpiarViejos()
  } catch (err) {
    console.warn("[v0] No se pudieron guardar los aplazados:", err)
  }
}

/** La hora, en el formato corto que ya usan las tarjetas de Gestionados. */
function horaAhora(): string {
  return new Date().toLocaleTimeString("es-CO", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota",
  })
}

export function aplazar(rutaId: number, loanId: string): Map<string, string> {
  const m = leerAplazados(rutaId)
  m.set(loanId, horaAhora())
  guardar(rutaId, m)
  return m
}

export function quitarAplazado(rutaId: number, loanId: string): Map<string, string> {
  const m = leerAplazados(rutaId)
  m.delete(loanId)
  guardar(rutaId, m)
  return m
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
