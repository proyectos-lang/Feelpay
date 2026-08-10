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

/**
 * Pide la posicion actual con la precision mas alta disponible.
 *
 * Rechaza con "GPS_DENIED" o "GPS_UNAVAILABLE" para que quien llama pueda
 * distinguir un permiso negado de un chip que no engancho.
 *
 * `maximumAge: 0` a proposito: cada gestion es en un punto distinto y una
 * posicion cacheada seria la del cliente anterior. El timeout de 10s le da
 * margen al warm-up del GPS en moviles.
 */
export function obtenerUbicacion(): Promise<UbicacionMedida> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("GPS_UNAVAILABLE"))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitud: position.coords.latitude,
          longitud: position.coords.longitude,
          // accuracy es obligatorio en la spec y siempre viene poblado,
          // pero si algun navegador lo deja en null tratamos la lectura
          // como imprecisa en vez de como perfecta.
          precision: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : Number.POSITIVE_INFINITY,
        })
      },
      (error) => {
        reject(new Error(error.code === 1 ? "GPS_DENIED" : "GPS_UNAVAILABLE"))
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  })
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
