"use client"

// Geolocalizacion y geocerca.
//
// La geocerca compara donde esta parado el cobrador contra donde quedo
// registrado el cliente, para que un pago solo se pueda gestionar en el
// sitio. Toda la regla de decision vive en `evaluarGeocerca` — las
// pantallas solo muestran el resultado.
//
// NO reutilizar la geolocalizacion de components/header.tsx: esa pide baja
// precision y acepta posiciones de hasta 30s de antiguedad, lo cual sirve
// para un indicador de estado pero no para decidir si alguien esta o no
// frente a la casa del cliente.

export interface Ubicacion {
  latitud: number
  longitud: number
}

export interface UbicacionMedida extends Ubicacion {
  /**
   * Radio de error que reporta el aparato, en metros (95% de confianza).
   * Un celular gama media entre edificios devuelve 20-65m sin problema.
   */
  precision: number
}

/** Una lectura del navegador, ya normalizada. */
function leer(opciones: PositionOptions): Promise<UbicacionMedida> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitud: position.coords.latitude,
          longitud: position.coords.longitude,
          // accuracy es obligatorio en la spec y siempre viene poblado,
          // pero si algun navegador lo deja en null tratamos la lectura
          // como imprecisa en vez de como perfecta.
          precision: Number.isFinite(position.coords.accuracy)
            ? position.coords.accuracy
            : Number.POSITIVE_INFINITY,
        })
      },
      reject,
      opciones,
    )
  })
}

/**
 * Pide la posicion actual. DOS INTENTOS, y el segundo es el que salva iPhone.
 *
 * PRIMERO: alta precision, 20s, sin aceptar nada cacheado. Es la lectura buena
 * — la del GPS de verdad — y es la que se quiere para una gestion.
 *
 * SI ESE SE PASA DE TIEMPO: baja precision, 8s, aceptando una posicion de
 * hasta 60s. Esa la resuelve el telefono por wifi y antenas, y vuelve casi al
 * instante.
 *
 * POR QUE HIZO FALTA
 * En iPhone el usuario tocaba "Permitir" y la pantalla igual decia que no
 * habia GPS. El permiso estaba dado: lo que fallaba era el fix. Un iPhone
 * pidiendo alta precision con `maximumAge: 0` tiene que encender el chip y
 * esperar satelites, y bajo techo eso pasa de 10s sin problema. El timeout
 * saltaba, el error llegaba como "no disponible" y quedaba igual que un
 * permiso negado.
 *
 * Una posicion por antenas tiene cientos de metros de error, pero para lo que
 * se usa —dejar constancia de donde se registro la gestion— vale
 * infinitamente mas que no tener nada. Y la imprecision no se oculta: viaja en
 * `precision`, y `evaluarGeocerca` ya sabe que una lectura mas imprecisa que
 * el radio no sirve para decidir ("no_verificable") y NO bloquea.
 *
 * Rechaza con "GPS_DENIED" cuando el permiso esta negado y "GPS_UNAVAILABLE"
 * en cualquier otro caso, para que quien llama pueda decir cual de los dos es.
 */
export function obtenerUbicacion(): Promise<UbicacionMedida> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.reject(new Error("GPS_UNAVAILABLE"))
  }

  return leer({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }).catch(
    (error: GeolocationPositionError) => {
      // Permiso negado: no hay segundo intento que valga.
      if (error?.code === 1) throw new Error("GPS_DENIED")

      return leer({ enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }).catch(
        (segundo: GeolocationPositionError) => {
          throw new Error(segundo?.code === 1 ? "GPS_DENIED" : "GPS_UNAVAILABLE")
        },
      )
    },
  )
}

const RADIO_TIERRA_M = 6371000

/** Distancia en metros entre dos puntos (Haversine). Mismo calculo que la funcion SQL `distancia_metros`. */
export function distanciaMetros(a: Ubicacion, b: Ubicacion): number {
  const rad = Math.PI / 180
  const dLat = (b.latitud - a.latitud) * rad
  const dLon = (b.longitud - a.longitud) * rad
  const lat1 = a.latitud * rad
  const lat2 = b.latitud * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * RADIO_TIERRA_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * - `sin_referencia`: el cliente todavia no tiene ubicacion guardada.
 * - `dentro`: verificado, esta donde debe estar.
 * - `no_verificable`: la lectura del GPS es tan imprecisa que no alcanza para decidir.
 * - `fuera`: esta lejos del cliente.
 */
export type GeocercaEstado = "sin_referencia" | "dentro" | "no_verificable" | "fuera"

export interface ResultadoGeocerca {
  estado: GeocercaEstado
  /** Distancia al cliente en metros. null cuando no hay con que comparar. */
  distancia: number | null
  /** Solo `fuera` impide continuar sin justificacion escrita. */
  bloquea: boolean
}

/**
 * Unico lugar donde se decide si un cobro esta dentro de rango.
 *
 * Nunca bloquea por una lectura mala: si el aparato admite un error mayor
 * que el radio configurado, su posicion no sirve para decidir y se deja
 * pasar marcada como no verificable. Bloquear ahi seria castigar al
 * cobrador por estar bajo un techo o por el clima.
 */
export function evaluarGeocerca(args: {
  cobrador: UbicacionMedida
  cliente: Ubicacion | null
  radioMetros: number
}): ResultadoGeocerca {
  const { cobrador, cliente, radioMetros } = args

  if (!cliente || !Number.isFinite(cliente.latitud) || !Number.isFinite(cliente.longitud)) {
    return { estado: "sin_referencia", distancia: null, bloquea: false }
  }

  const distancia = distanciaMetros(cobrador, cliente)

  if (cobrador.precision > radioMetros) {
    return { estado: "no_verificable", distancia, bloquea: false }
  }

  if (distancia <= radioMetros) {
    return { estado: "dentro", distancia, bloquea: false }
  }

  return { estado: "fuera", distancia, bloquea: true }
}

/** Distancia lista para mostrar: "45 m" / "1.2 km". */
export function formatearDistancia(metros: number): string {
  if (metros < 1000) return `${Math.round(metros)} m`
  return `${(metros / 1000).toFixed(1)} km`
}
