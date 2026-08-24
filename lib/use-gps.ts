"use client"

/**
 * lib/use-gps.ts
 * ---------------------------------------------------------------------------
 * ¿Puede esta app leer la ubicación? UNA sola respuesta para toda la pantalla.
 *
 * POR QUÉ EXISTE
 * El encabezado y el módulo de pagos lo averiguaban cada uno por su lado, con
 * lógicas distintas: el encabezado preguntaba UNA vez al abrir y nunca más, y
 * pagos usaba la Permissions API. Resultado: el cobrador daba el permiso en la
 * pantalla de pagos y el encabezado seguía con la pastilla roja de "Sin
 * ubicación", porque nadie le avisó. Dos indicadores del mismo dato
 * contradiciéndose.
 *
 * LO QUE APRENDIMOS DE IPHONE, Y ESTÁ METIDO ACÁ
 *
 *  · `navigator.permissions` puede NO EXISTIR (iOS viejo). Ahí `.query`
 *    revienta con un TypeError SÍNCRONO que un `.catch()` ni ve. Va todo
 *    dentro de un try.
 *
 *  · Safari moderno sí tiene la API pero NO soporta 'geolocation': la promesa
 *    se rechaza. Por eso la API es un atajo, no el camino — ante cualquier
 *    problema se le pregunta al GPS directo.
 *
 *  · Preguntar con alta precisión solo para saber si HAY permiso es carísimo:
 *    obliga a encender el chip y esperar satélites, y bajo techo se pasa de
 *    los diez segundos. Acá se pregunta con baja precisión aceptando una
 *    posición vieja: se resuelve por wifi y antenas, casi al instante. La
 *    lectura buena la toma `obtenerUbicacion` cuando hay que registrar algo.
 *
 *  · En iOS, habilitar la ubicación se hace en Ajustes y el usuario VUELVE a
 *    la app. Sin volver a mirar, la pantalla se queda en rojo para siempre.
 *    Por eso se re-consulta al recuperar el foco y al volver a ser visible.
 */

import { useCallback, useEffect, useRef, useState } from "react"

export type EstadoGps = "checking" | "granted" | "denied" | "unavailable"

/** Barato a propósito: solo interesa si el teléfono contesta, no dónde está. */
const SONDEO: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 15000,
  maximumAge: 300000,
}

export function useEstadoGps(): { estado: EstadoGps; volverAPedir: () => void } {
  const [estado, setEstado] = useState<EstadoGps>("checking")
  const vivoRef = useRef(true)

  const aplicar = useCallback((s: EstadoGps) => {
    if (vivoRef.current) setEstado(s)
  }, [])

  const preguntarAlGps = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      aplicar("unavailable")
      return
    }
    navigator.geolocation.getCurrentPosition(
      () => aplicar("granted"),
      (e) => aplicar(e.code === 1 ? "denied" : "unavailable"),
      SONDEO,
    )
  }, [aplicar])

  const volverAPedir = useCallback(() => {
    aplicar("checking")
    preguntarAlGps()
  }, [aplicar, preguntarAlGps])

  useEffect(() => {
    vivoRef.current = true
    if (typeof window === "undefined" || !navigator.geolocation) {
      setEstado("unavailable")
      return
    }

    let permResult: PermissionStatus | null = null
    let resuelto = false
    const marcar = (s: EstadoGps) => {
      resuelto = true
      aplicar(s)
    }

    const consultar = () => {
      try {
        // `?.` en los dos: ni el objeto ni el método están garantizados.
        const p = navigator.permissions?.query?.({ name: "geolocation" as PermissionName })
        if (p) {
          p.then((result) => {
            if (!vivoRef.current) return
            permResult = result
            if (result.state === "granted") marcar("granted")
            else if (result.state === "denied") marcar("denied")
            else preguntarAlGps() // "prompt": hay que pedirlo de verdad
            result.onchange = () => {
              if (result.state === "granted") marcar("granted")
              else if (result.state === "denied") marcar("denied")
              else preguntarAlGps()
            }
          }).catch(preguntarAlGps)
        } else {
          preguntarAlGps()
        }
      } catch {
        preguntarAlGps()
      }
    }

    consultar()

    // Volver de Ajustes tiene que notarse. En iOS es EL camino para habilitar
    // la ubicación después de haberla negado, y sin esto la app se queda en
    // rojo aunque el usuario ya la haya activado.
    const alVolver = () => {
      if (document.visibilityState === "visible") {
        // Solo se reintenta si NO está concedido: si ya funciona, volver a la
        // app no tiene por qué encender el GPS otra vez.
        setEstado((actual) => {
          if (actual !== "granted") preguntarAlGps()
          return actual
        })
      }
    }
    document.addEventListener("visibilitychange", alVolver)
    window.addEventListener("focus", alVolver)

    // Red de seguridad: quedarse en "checking" para siempre deja la pantalla
    // inutilizable sin explicar por qué.
    const reloj = setTimeout(() => {
      if (!resuelto) aplicar("unavailable")
    }, 20000)

    return () => {
      vivoRef.current = false
      clearTimeout(reloj)
      document.removeEventListener("visibilitychange", alVolver)
      window.removeEventListener("focus", alVolver)
      if (permResult) permResult.onchange = null
    }
  }, [aplicar, preguntarAlGps])

  return { estado, volverAPedir }
}
