"use client"

/**
 * lib/actualizar-app.ts
 * ---------------------------------------------------------------------------
 * Traer la versión nueva de la app sin tener que refrescar pantalla por
 * pantalla.
 *
 * EL PROBLEMA, TAL COMO PASÓ
 * La app es una sola página. Se abre por la mañana y no se vuelve a cargar en
 * todo el día: cambiar de módulo no recarga nada, solo cambia lo que se pinta.
 * Un despliegue a las nueve no llega a un teléfono que lleva abierto desde las
 * siete, y como el trabajo no se interrumpe, nadie recarga. David trabajó una
 * jornada entera con la versión de la mañana.
 *
 * Los botones de refrescar que ya existen —el del Monitoreo, el de la lista de
 * clientes— vuelven a pedir los DATOS. No traen código nuevo. Por eso
 * refrescar en cada ventana no arreglaba nada: los datos ya estaban bien, lo
 * viejo era la app.
 *
 * POR QUÉ EL SERVICE WORKER NO ALCANZA
 * `sw.js` solo cambia cuando cambia su propio contenido, así que un despliegue
 * normal no dispara ningún `updatefound`. Y su caché de assets es
 * "servir lo guardado y refrescar por detrás": la primera carga después del
 * despliegue todavía puede salir del disco. Hay que borrarlo y recargar.
 */

import { marcarRecargaPropia } from "@/lib/pin-lock"

const CLAVE_VERSION = "appVersionVista"

/** Lo que el servidor dice que está publicado ahora. `null` si no se pudo. */
export async function versionPublicada(): Promise<string | null> {
  try {
    const r = await fetch("/api/version", { cache: "no-store" })
    if (!r.ok) return null
    const j = (await r.json()) as { version?: string }
    return j.version ?? null
  } catch {
    // Sin señal no hay nada que avisar. Se calla: un aviso de "no pude
    // comprobar si hay versión nueva" no le sirve a nadie en la calle.
    return null
  }
}

/**
 * La versión que esta pestaña está corriendo.
 *
 * Se guarda la primera vez que se comprueba y NO se vuelve a tocar mientras la
 * página viva. Ese es el truco: si después el servidor contesta otra cosa, es
 * que hubo un despliegue mientras esta pestaña seguía abierta — que es
 * exactamente lo que hay que detectar.
 */
export function versionEnUso(): string | null {
  if (typeof window === "undefined") return null
  try {
    return sessionStorage.getItem(CLAVE_VERSION)
  } catch {
    return null
  }
}

export function fijarVersionEnUso(v: string): void {
  if (typeof window === "undefined") return
  try {
    sessionStorage.setItem(CLAVE_VERSION, v)
  } catch {
    /* modo privado */
  }
}

/**
 * ¿Hay una versión nueva publicada?
 *
 * Devuelve `false` mientras no se pueda saber. En la primera comprobación se
 * apunta la versión en uso y no se avisa nada: recién se abrió la app, ya está
 * al día.
 */
export async function hayVersionNueva(): Promise<boolean> {
  const publicada = await versionPublicada()
  if (!publicada) return false
  const enUso = versionEnUso()
  if (!enUso) {
    fijarVersionEnUso(publicada)
    return false
  }
  return enUso !== publicada
}

/**
 * Traer la versión nueva. Es lo que hace el botón.
 *
 * En orden, y el orden importa:
 *   1. se borran los cachés del service worker —si no, la recarga puede
 *      volver a servir los mismos archivos viejos del disco—;
 *   2. se le pide al service worker que se actualice;
 *   3. se olvida la versión apuntada, para que la app que arranque apunte la
 *      suya;
 *   4. se recarga.
 *
 * NO se toca la cola de escrituras pendientes (`feelpay-offline`) ni el caché
 * de lectura (`feelpay-cache`): los dos son de datos, no de código, y el
 * segundo se refresca solo. Borrar la cola acá sería tirar pagos capturados
 * sin señal para arreglar un problema que no tiene nada que ver.
 */
export async function actualizarApp(): Promise<void> {
  try {
    if (typeof caches !== "undefined") {
      const nombres = await caches.keys()
      await Promise.all(nombres.map((n) => caches.delete(n)))
    }
  } catch (err) {
    console.warn("[v0] No se pudieron borrar los cachés:", err)
  }

  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.update().catch(() => {})))
    }
  } catch (err) {
    console.warn("[v0] No se pudo actualizar el service worker:", err)
  }

  try {
    sessionStorage.removeItem(CLAVE_VERSION)
  } catch {
    /* modo privado */
  }

  // El candado no puede distinguir esta recarga de "cerró la app y la volvió a
  // abrir", y sin este aviso el cobrador teclea el PIN cada vez que actualiza.
  // Va JUSTO antes de navegar para que la marca no quede puesta si algo falla
  // más arriba y la recarga nunca ocurre.
  marcarRecargaPropia()

  // `reload()` a secas puede salir del bfcache con la misma página. Volver a
  // pedir la URL sin fragmento fuerza una navegación de verdad.
  window.location.replace(window.location.pathname + window.location.search)
}
