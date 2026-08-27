"use client"

import { createClient } from "@/lib/supabase/client"

export interface RutaUmbrales {
  venta_nueva_habilitado: boolean
  venta_nueva_umbral: number | null
  venta_renovacion_habilitado: boolean
  venta_renovacion_umbral: number | null
  // Umbral de abonos: cantidad de cuotas pagadas de una sola vez (pago
  // normal), NO un monto en pesos.
  abono_habilitado: boolean
  abono_umbral_cuotas: number | null
  // Multas por mora: si el cliente acumula multa_cuotas_umbral cuotas
  // vencidas, se le genera una multa. El valor de esa multa se calcula
  // segun multa_tipo_valor: 'fijo' usa multa_valor en pesos directamente,
  // 'cuotas' multiplica multa_cantidad_cuotas por el valor de una cuota
  // del prestamo (multiplicador fijo, no escala con cuotas vencidas).
  multa_habilitada: boolean
  multa_cuotas_umbral: number | null
  multa_tipo_valor: "fijo" | "cuotas"
  multa_valor: number | null
  multa_cantidad_cuotas: number | null
  // Logo propio de la ruta para el recibo. null = se usa el de la app.
  logo_url: string | null
  // Geocerca: el cobro solo se puede registrar cerca de donde quedo
  // ubicado el cliente. Llega apagada; se enciende ruta por ruta cuando ya
  // hay ubicaciones capturadas con que comparar.
  //
  // El radio NO puede ser muy chico: el GPS de un celular tiene 5-20m de
  // error con buena senal y 50-100m+ bajo techo o entre edificios, asi que
  // un radio de 20m bloquearia cobros validos.
  geocerca_habilitada: boolean
  geocerca_radio_metros: number
  // Métodos de interés que usa la unidad. El formulario de venta solo
  // ofrece estos, y `amortizacion_default` llega preseleccionado. Ofrecer
  // siempre los dos, sin ninguno marcado, era una forma silenciosa de
  // equivocarse: el vendedor tenía que acordarse del correcto en cada venta.
  amortizaciones_habilitadas: string[]
  amortizacion_default: string | null
  // ¿Hace falta fotografiar la cédula para registrar un cliente nuevo?
  //
  // Es la única bandera de esta interfaz que arranca ENCENDIDA, y a propósito:
  // las demás son restricciones que se activan, y esta ya está activa en el
  // código de hoy —el formulario de venta no deja escribir el documento a
  // mano—. El default `true` es lo que hace que apagar el interruptor sea una
  // decisión y no un efecto secundario.
  //
  // Y por eso FALLA CERRADA: sin fila, con error de red o con un cache viejo,
  // vale `true`. Una restricción que se afloja sola cuando algo sale mal no
  // protege nada.
  cedula_obligatoria: boolean
}

const DEFAULT_UMBRALES: RutaUmbrales = {
  venta_nueva_habilitado: false, venta_nueva_umbral: null,
  venta_renovacion_habilitado: false, venta_renovacion_umbral: null,
  abono_habilitado: false, abono_umbral_cuotas: null,
  multa_habilitada: false, multa_cuotas_umbral: null,
  multa_tipo_valor: "fijo", multa_valor: null, multa_cantidad_cuotas: null,
  logo_url: null,
  geocerca_habilitada: false, geocerca_radio_metros: 100,
  // Sin configurar, la ruta sigue viendo los dos como hasta hoy.
  amortizaciones_habilitadas: ["aleman", "americano"],
  amortizacion_default: null,
  cedula_obligatoria: true,
}

// Cache local de los umbrales por ruta.
//
// Sin conexion la consulta falla y se caeria a DEFAULT_UMBRALES (todo
// deshabilitado), lo que significa "ninguna operacion necesita revision" — y
// una venta grande registrada offline se aplicaria directo en vez de pasar
// por secretaria. Guardando el ultimo valor leido, la decision offline es la
// misma que se habria tomado con senal.
const UMBRALES_CACHE_KEY = "ruta_umbrales_cache"

function leerCache(rutaId: number): RutaUmbrales | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(`${UMBRALES_CACHE_KEY}_${rutaId}`)
    if (!raw) return null
    // Se mezcla sobre los defaults: un cache guardado antes de que existiera
    // un campo nuevo no lo trae, y sin esto llegaria `undefined` a quien lo
    // use (el radio de la geocerca, por ejemplo).
    return { ...DEFAULT_UMBRALES, ...(JSON.parse(raw) as Partial<RutaUmbrales>) }
  } catch {
    return null
  }
}

function guardarCache(rutaId: number, u: RutaUmbrales): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(`${UMBRALES_CACHE_KEY}_${rutaId}`, JSON.stringify(u))
  } catch {
    /* cuota de almacenamiento llena o modo privado: no es critico */
  }
}

// Las columnas que existían antes del script 080, y esa lista más la columna
// que ese script agrega.
//
// POR QUÉ SON DOS Y NO UNA.
// PostgREST no ignora una columna que no existe: tumba la consulta ENTERA con
// «column ... does not exist» (42703). Como el despliegue de la app y la
// corrida del script son dos actos separados, pedir la columna nueva sin más
// dejaba una ventana —entre uno y otro— en la que ESTA función fallaba para
// todas las rutas, y con ella se caían la geocerca, los umbrales y los métodos
// de interés. Se pide la columna nueva y, si la base todavía no la tiene, se
// reintenta sin ella. El reintento desaparece solo en cuanto el script corra.
const COLUMNAS_BASE =
  "venta_nueva_habilitado, venta_nueva_umbral, venta_renovacion_habilitado, venta_renovacion_umbral, abono_habilitado, abono_umbral_cuotas, multa_habilitada, multa_cuotas_umbral, multa_tipo_valor, multa_valor, multa_cantidad_cuotas, logo_url, geocerca_habilitada, geocerca_radio_metros, amortizaciones_habilitadas, amortizacion_default"
const COLUMNAS = `${COLUMNAS_BASE}, cedula_obligatoria`

// Si la ruta no tiene fila configurada, no hay revisión (falla abierta hacia
// "sin revisión" para no bloquear la operación normal si algo sale mal).
export async function getRutaUmbrales(rutaId: number): Promise<RutaUmbrales> {
  try {
    const supabase = createClient()
    const pedir = (columnas: string) =>
      supabase.from("ruta_config_umbrales").select(columnas).eq("ruta_id", rutaId).maybeSingle()

    let { data, error } = await pedir(COLUMNAS)
    if (error?.code === "42703") {
      console.warn("[v0] `cedula_obligatoria` no existe todavía — corre scripts/080. Se pide sin ella.")
      ;({ data, error } = await pedir(COLUMNAS_BASE))
    }
    if (error) return leerCache(rutaId) ?? DEFAULT_UMBRALES
    if (!data) return DEFAULT_UMBRALES
    const fila = data as Partial<RutaUmbrales>
    const umbrales = {
      ...DEFAULT_UMBRALES,
      ...fila,
      // Una lista vacía dejaría el formulario de venta sin ninguna opción:
      // se trata como "no configurado" y se cae a los dos métodos.
      amortizaciones_habilitadas:
        fila.amortizaciones_habilitadas && fila.amortizaciones_habilitadas.length > 0
          ? fila.amortizaciones_habilitadas
          : DEFAULT_UMBRALES.amortizaciones_habilitadas,
      // Explícito, y no por el spread: en el reintento sin la columna la clave
      // no viene, y el spread dejaría `undefined` donde tiene que haber `true`.
      // La cédula dejaría de pedirse en todas las rutas por un script que
      // falta correr.
      cedula_obligatoria: fila.cedula_obligatoria ?? DEFAULT_UMBRALES.cedula_obligatoria,
    }
    guardarCache(rutaId, umbrales)
    return umbrales
  } catch (err) {
    console.error("[v0] Error fetching ruta_config_umbrales:", err)
    return leerCache(rutaId) ?? DEFAULT_UMBRALES
  }
}

// Umbral de gasto/ingreso/retiro: se configura por item (concepto especifico
// del catalogo), no como un valor unico compartido por ruta.
export interface ItemUmbral {
  habilitado: boolean
  umbral: number | null
}

export async function getRutaItemUmbrales(rutaId: number): Promise<Map<string, ItemUmbral>> {
  const map = new Map<string, ItemUmbral>()
  try {
    const { data, error } = await createClient()
      .from("ruta_item_umbrales")
      .select("item_tipo, item_id, habilitado, umbral")
      .eq("ruta_id", rutaId)
    // OJO: supabase-js NO lanza excepcion ante un error de PostgREST, lo
    // devuelve en `error` con `data` en null. Sin revisarlo, una tabla que no
    // existe (script sin correr) devolvia un mapa vacio en silencio y NINGUN
    // movimiento superaba nunca su umbral: la revision de secretaria quedaba
    // apagada sin que nadie se enterara.
    if (error) {
      console.error("[v0] No se pudieron leer los umbrales por item — la revision de secretaria NO se aplicara:", error.message)
      return map
    }
    for (const row of (data ?? []) as { item_tipo: string; item_id: number; habilitado: boolean; umbral: number | null }[]) {
      map.set(`${row.item_tipo}:${row.item_id}`, { habilitado: row.habilitado, umbral: row.umbral })
    }
  } catch (err) {
    console.error("[v0] Error fetching ruta_item_umbrales:", err)
  }
  return map
}

export function excedeUmbral(habilitado: boolean, umbral: number | null, monto: number): boolean {
  return habilitado && umbral !== null && monto > umbral
}

export const MENSAJE_REVISION = "Este movimiento pasará a revisión de la secretaria"

export function getSolicitanteNombre(): string | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem("currentUser")
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.nombre ?? null
  } catch {
    return null
  }
}
