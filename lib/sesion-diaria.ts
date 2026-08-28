"use client"

/**
 * lib/sesion-diaria.ts
 * ---------------------------------------------------------------------------
 * La sesión dura UN DÍA. Al cambiar el día hay que volver a entrar con usuario
 * y contraseña, se haya cerrado sesión a mano o no.
 *
 * POR QUÉ EXISTE
 * La sesión vive en localStorage y no caduca: un teléfono que no se cierra
 * queda abierto para siempre, y con él la ruta, la plata y los permisos de esa
 * persona. Quien lo tome al día siguiente entra sin que nadie le pregunte
 * nada. El PIN (`lib/pin-lock.ts`) tapa el rato que el teléfono está en el
 * bolsillo; esto tapa el día siguiente, y son cosas distintas: el PIN son
 * cuatro dígitos que el equipo comparte, la contraseña no.
 *
 * EL DÍA ES EL DE COLOMBIA, NO EL DEL TELÉFONO
 * Todo el negocio se cuenta en día de Colombia —el recaudo, la caja, el
 * cronograma— y la sesión tiene que caducar cuando cambia ESE día. Con el día
 * local, un teléfono con la zona horaria corrida caducaría a una hora que no
 * le corresponde a ninguna jornada.
 *
 * CUALQUIER CAMBIO CADUCA, no solo el avance
 * Si el día guardado no es exactamente el de hoy, se pide login. Un día
 * GUARDADO EN EL FUTURO no es normal —significa que el reloj del aparato
 * estaba mal cuando se entró— y ante eso lo prudente es preguntar de nuevo,
 * no confiar.
 *
 * SIN DÍA GUARDADO TAMBIÉN CADUCA
 * Es el caso de las sesiones que ya estaban abiertas cuando esto se
 * desplegó: no hay forma de saber de qué día son. Todo el mundo entra una vez
 * más y de ahí en adelante la marca ya existe.
 *
 * LO QUE **NO** SE PIERDE
 * El cierre de sesión borra `localStorage` y el cache de lectura
 * (`feelpay-cache`). La cola de escrituras pendientes vive en OTRA base
 * (`feelpay-offline`) y no se toca: los pagos capturados sin señal siguen ahí
 * y se envían solos cuando la persona vuelva a entrar.
 */

import { todayColombia } from "@/lib/colombia-date"

const CLAVE = "sesionDia"

/** Deja marcado el día en que se entró. Se llama justo después del login. */
export function marcarDiaDeSesion(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(CLAVE, todayColombia())
  } catch (err) {
    // Sin marca, la sesión caduca en la siguiente comprobación. Es el lado
    // seguro del error: se pide contraseña de más, nunca de menos.
    console.warn("[v0] No se pudo marcar el día de la sesión:", err)
  }
}

/** El día en que se entró, o null si no hay marca. */
export function diaDeSesion(): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(CLAVE)
  } catch {
    return null
  }
}

export function limpiarDiaDeSesion(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(CLAVE)
  } catch {
    /* modo privado o cuota llena: no es crítico */
  }
}

/**
 * ¿La sesión guardada es de otro día?
 *
 * Devuelve `false` cuando no hay ninguna sesión que caducar — no tiene sentido
 * anunciarle a nadie que su sesión venció si no había entrado.
 */
export function sesionVencioPorDia(haySesion: boolean): boolean {
  if (!haySesion) return false
  return diaDeSesion() !== todayColombia()
}

/** El aviso que se le muestra a la persona en la pantalla de entrada. */
export const MENSAJE_SESION_DIARIA =
  "Tu sesión se cerró porque cambió el día. Vuelve a entrar con tu usuario y contraseña para trabajar la jornada de hoy."
