/**
 * lib/monedas.ts
 * ---------------------------------------------------------------------------
 * LAS MONEDAS CON LAS QUE TRABAJA CADA RUTA.
 *
 * Hasta ahora toda la plata se mostraba con un `$` y formato `es-CO`, sin que
 * nada dijera de qué moneda se hablaba. Funcionaba mientras todo era Colombia;
 * con rutas en Argentina, Ecuador y Paraguay, el mismo `$1.200` significa
 * cosas muy distintas según dónde se mire.
 *
 * Acá vive la lista y las reglas de formato. La ruta guarda SOLO el código
 * (`rutas.moneda` = 'ARS', 'USD'…) y todo lo demás —símbolo, decimales,
 * separadores— sale de esta tabla. Así, cambiarle el símbolo al guaraní es
 * tocar una línea y no buscar por toda la app.
 *
 * EL CÓDIGO ES ISO 4217 (ARS, COP, USD…), que es el estándar y evita discutir
 * si el peso argentino se abrevia "AR$" o "$a".
 */

export interface Moneda {
  /** ISO 4217. Es lo que se guarda en `rutas.moneda`. */
  codigo: string
  nombre: string
  simbolo: string
  pais: string
  /**
   * CUÁNTOS DECIMALES SE MUESTRAN.
   *
   * No es un detalle estético. En Colombia, Paraguay, Chile y Argentina nadie
   * escribe los centavos —una cuota es $22.400, no $22.400,00— mientras que en
   * dólares el centavo sí cuenta: una cuota de $22.40 con cero decimales se
   * vería como $22 y estaría perdiendo plata a la vista del cliente.
   */
  decimales: number
  /**
   * El `locale` que decide los separadores. Ecuador y Panamá usan dólar pero
   * escriben 1.234,56 como en el resto de la región, no 1,234.56.
   */
  locale: string
}

/**
 * LA LIBRERÍA: Latinoamérica más el dólar.
 *
 * Están todas aunque hoy solo se usen cuatro: la idea es que abrir una ruta en
 * Perú sea elegir de una lista, no tocar código. El dólar va primero porque es
 * el que comparten varios países (Ecuador, Panamá, El Salvador) y el que se
 * usa como referencia.
 */
export const MONEDAS: Moneda[] = [
  { codigo: "USD", nombre: "Dólar estadounidense", simbolo: "$",    pais: "Estados Unidos", decimales: 2, locale: "es-EC" },
  { codigo: "ARS", nombre: "Peso argentino",       simbolo: "$",    pais: "Argentina",      decimales: 0, locale: "es-AR" },
  { codigo: "BOB", nombre: "Boliviano",            simbolo: "Bs",   pais: "Bolivia",        decimales: 2, locale: "es-BO" },
  { codigo: "BRL", nombre: "Real brasileño",       simbolo: "R$",   pais: "Brasil",         decimales: 2, locale: "pt-BR" },
  { codigo: "CLP", nombre: "Peso chileno",         simbolo: "$",    pais: "Chile",          decimales: 0, locale: "es-CL" },
  { codigo: "COP", nombre: "Peso colombiano",      simbolo: "$",    pais: "Colombia",       decimales: 0, locale: "es-CO" },
  { codigo: "CRC", nombre: "Colón costarricense",  simbolo: "₡",    pais: "Costa Rica",     decimales: 2, locale: "es-CR" },
  { codigo: "CUP", nombre: "Peso cubano",          simbolo: "$",    pais: "Cuba",           decimales: 2, locale: "es-CU" },
  { codigo: "DOP", nombre: "Peso dominicano",      simbolo: "RD$",  pais: "República Dominicana", decimales: 2, locale: "es-DO" },
  { codigo: "GTQ", nombre: "Quetzal",              simbolo: "Q",    pais: "Guatemala",      decimales: 2, locale: "es-GT" },
  { codigo: "HNL", nombre: "Lempira",              simbolo: "L",    pais: "Honduras",       decimales: 2, locale: "es-HN" },
  { codigo: "MXN", nombre: "Peso mexicano",        simbolo: "$",    pais: "México",         decimales: 2, locale: "es-MX" },
  { codigo: "NIO", nombre: "Córdoba",              simbolo: "C$",   pais: "Nicaragua",      decimales: 2, locale: "es-NI" },
  { codigo: "PAB", nombre: "Balboa",               simbolo: "B/.",  pais: "Panamá",         decimales: 2, locale: "es-PA" },
  { codigo: "PEN", nombre: "Sol",                  simbolo: "S/",   pais: "Perú",           decimales: 2, locale: "es-PE" },
  { codigo: "PYG", nombre: "Guaraní",              simbolo: "₲",    pais: "Paraguay",       decimales: 0, locale: "es-PY" },
  { codigo: "UYU", nombre: "Peso uruguayo",        simbolo: "$U",   pais: "Uruguay",        decimales: 2, locale: "es-UY" },
  { codigo: "VES", nombre: "Bolívar",              simbolo: "Bs.",  pais: "Venezuela",      decimales: 2, locale: "es-VE" },
]

/** La moneda con la que se trabaja si una ruta no tiene ninguna elegida. */
export const MONEDA_POR_DEFECTO = "COP"

const PORCODIGO = new Map(MONEDAS.map((m) => [m.codigo, m]))

/**
 * QUÉ MONEDA LE TOCA A CADA PAÍS.
 *
 * Las claves van en minúscula y sin tildes porque en la base conviven
 * "ARGENTINA", "Argentina" y "PARAGUAY": se normaliza antes de buscar.
 *
 * Ecuador y Panamá usan el dólar, así que apuntan a USD y no a una moneda
 * propia — Ecuador no tiene sucre desde el año 2000.
 */
const PAIS_A_MONEDA: Record<string, string> = {
  argentina: "ARS",
  bolivia: "BOB",
  brasil: "BRL",
  brazil: "BRL",
  chile: "CLP",
  colombia: "COP",
  "costa rica": "CRC",
  cuba: "CUP",
  ecuador: "USD",
  "el salvador": "USD",
  "estados unidos": "USD",
  guatemala: "GTQ",
  honduras: "HNL",
  mexico: "MXN",
  nicaragua: "NIO",
  panama: "PAB",
  paraguay: "PYG",
  peru: "PEN",
  "republica dominicana": "DOP",
  uruguay: "UYU",
  venezuela: "VES",
}

/**
 * CIUDADES QUE APARECEN DONDE DEBERÍA IR EL PAÍS.
 *
 * No es una hipótesis: la ruta 204 tiene `pais = 'BUENOS AIRES'` y
 * `ciudad = 'ARGENTINA'`, o sea las dos columnas al revés. Sin esta tabla esa
 * ruta se quedaría sin moneda, que es justamente la que más se usa.
 *
 * Es la misma lista que ya se usa para los dígitos del celular en
 * `new-loan.tsx`; acá se repite a propósito para que este archivo se pueda
 * leer solo.
 */
const CIUDAD_A_PAIS: Record<string, string> = {
  "buenos aires": "argentina",
  "la plata": "argentina",
  chaco: "argentina",
  rosario: "argentina",
  cordoba: "argentina",
  cali: "colombia",
  bogota: "colombia",
  medellin: "colombia",
  cuenca: "ecuador",
  quito: "ecuador",
  guayaquil: "ecuador",
  ibarra: "ecuador",
  rioamba: "ecuador",
  riobamba: "ecuador",
  asuncion: "paraguay",
  "ciudad del este": "paraguay",
}

/** Minúsculas y sin tildes, que es como están escritas las claves de arriba. */
function normalizar(texto: string | null | undefined): string {
  return (texto ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
}

/**
 * LA MONEDA QUE LE CORRESPONDE A UNA RUTA POR SU PAÍS.
 *
 * Se mira primero el país y, si no se reconoce, la ciudad — que es el caso de
 * la 204, con las dos columnas cambiadas. Si nada calza devuelve `null`: NO se
 * inventa una moneda. Una ruta con moneda equivocada muestra cifras creíbles
 * pero falsas, que es peor que una ruta sin moneda, la cual se nota y se
 * arregla.
 */
export function monedaPorPais(
  pais: string | null | undefined,
  ciudad?: string | null,
): string | null {
  const p = normalizar(pais)
  if (PAIS_A_MONEDA[p]) return PAIS_A_MONEDA[p]

  // El país no se reconoce. ¿Será que ahí hay una ciudad?
  const comoCiudad = CIUDAD_A_PAIS[p]
  if (comoCiudad) return PAIS_A_MONEDA[comoCiudad] ?? null

  // Último intento: la columna `ciudad` puede traer el país.
  const c = normalizar(ciudad)
  if (PAIS_A_MONEDA[c]) return PAIS_A_MONEDA[c]
  const paisDeCiudad = CIUDAD_A_PAIS[c]
  if (paisDeCiudad) return PAIS_A_MONEDA[paisDeCiudad] ?? null

  return null
}

/** Los datos de una moneda por su código. Cae en la por defecto si no existe. */
export function getMoneda(codigo: string | null | undefined): Moneda {
  return (
    PORCODIGO.get((codigo ?? "").trim().toUpperCase()) ??
    PORCODIGO.get(MONEDA_POR_DEFECTO)!
  )
}

/**
 * La plata escrita como se escribe en ese país.
 *
 * `$22.400` en Argentina, `$22.40` en dólares, `₲22.400` en Paraguay.
 */
export function formatearMoneda(
  valor: number | null | undefined,
  codigo: string | null | undefined,
): string {
  const m = getMoneda(codigo)
  const n = Number(valor) || 0
  return `${m.simbolo}${n.toLocaleString(m.locale, {
    minimumFractionDigits: m.decimales,
    maximumFractionDigits: m.decimales,
  })}`
}

// ── Conversión a dólares ────────────────────────────────────────────────────

/**
 * PASAR UN MONTO A DÓLARES CON LA TASA DE SU DÍA.
 *
 * `tasa` es cuánta moneda local vale 1 USD —"el dólar está a 1.450" es
 * 1450— así que se DIVIDE. Ver `scripts/119`, que es donde vive la historia
 * de tasas y la función `tasa_vigente(moneda, fecha)` que las busca.
 *
 * Devuelve `null` cuando no hay tasa para ese día, y eso es a propósito: la
 * pantalla tiene que poder decir "sin tasa" en vez de mostrar un 0 que se lee
 * como plata. Un cero inventado en un informe es peor que un hueco visible.
 */
export function aDolares(
  monto: number | null | undefined,
  tasa: number | null | undefined,
): number | null {
  const n = Number(monto) || 0
  const t = Number(tasa)
  if (!Number.isFinite(t) || t <= 0) return null
  return n / t
}

/** Un monto en dólares, ya escrito: "USD 1.234,56". */
export function fmtDolares(valor: number | null | undefined): string {
  if (valor === null || valor === undefined) return "sin tasa"
  return `USD ${Number(valor).toLocaleString("es-CO", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
