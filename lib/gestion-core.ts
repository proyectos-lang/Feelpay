/**
 * lib/gestion-core.ts
 * ---------------------------------------------------------------------------
 * El vocabulario del núcleo, en un solo lugar.
 *
 * POR QUÉ EXISTE
 * Antes cada pantalla definía por su cuenta qué es "hoy", qué cuenta como
 * pago del día y cuándo un cliente está en mora. Había cinco definiciones
 * distintas de "pago de hoy", dos de "caja anterior" y la fecha Colombia
 * reescrita a mano en ocho archivos. Los números no cuadraban entre
 * pantallas porque literalmente no eran el mismo número.
 *
 * Todo lo que signifique algo del negocio se define AQUÍ y se importa.
 *
 * EL MODELO (scripts 041-049)
 * ---------------------------
 *   payment_plan  = el cronograma pactado. `fecha_pago` es el VENCIMIENTO y
 *                   no se pisa nunca. `estado`/`monto_pagado` son un cache
 *                   que escribe solo la base (recalcular_prestamo).
 *   gestiones     = el libro de eventos. Cada visita o movimiento es una
 *                   fila inmutable con `fecha_gestion` = el día de negocio
 *                   al que aplica.
 *
 * De ahí sale la regla que resuelve el lío de "ayer no se gestionó":
 * un cliente está GESTIONADO EL DÍA D si existe un evento aplicado con
 * fecha_gestion = D. Nada más. Ni estados de cuota, ni horas, ni ancla.
 */

import { todayColombia, tsToColombiaDate, fmtFecha, fmtFechaHora } from "@/lib/colombia-date"

export { todayColombia, tsToColombiaDate, fmtFecha, fmtFechaHora }

const TZ = "America/Bogota"

// ── Fechas ─────────────────────────────────────────────────────────────────

/** Día anterior a hoy en Colombia, "YYYY-MM-DD". El caso "ayer no se gestionó". */
export function ayerColombia(): string {
  return sumarDias(todayColombia(), -1)
}

/** Suma (o resta) días a una fecha "YYYY-MM-DD" sin cruzar zonas horarias. */
export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + dias)
  return dt.toISOString().slice(0, 10)
}

/** Diferencia en días entre dos fechas "YYYY-MM-DD" (b − a). */
export function diasEntre(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number)
  const [by, bm, bd] = b.split("-").map(Number)
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  )
}

/**
 * Instante actual como ISO con el desfase real de Colombia.
 * Se arma con Intl y no con un "-05:00" escrito a mano, para que el día y la
 * hora salgan de la misma fuente y no se puedan desincronizar.
 */
export function ahoraColombiaISO(): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date())
  const g = (t: string) => partes.find((p) => p.type === t)?.value ?? "00"
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}-05:00`
}

/** Hora "HH:MM" de un timestamp de la base, en hora Colombia. */
export function horaColombia(ts: string | null | undefined): string {
  if (!ts) return ""
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(new Date(ts))
}

// ── El libro de eventos ────────────────────────────────────────────────────

export type TipoGestion =
  | "pago" | "no_pago" | "cancelacion" | "abono_venta"
  | "extension" | "ajuste" | "reversa"

export type EstadoGestion = "aplicada" | "en_revision" | "rechazada"

export type OrigenGestion =
  | "campo" | "venta" | "homologacion" | "revision" | "ajuste" | "migracion"

export interface Gestion {
  id: string
  loan_id: string
  client_id: string | null
  ruta: number
  user_id: number | null
  tipo: TipoGestion
  estado: EstadoGestion
  fecha_gestion: string
  monto: number
  cuota_objetivo: string | null
  num_cuotas: number | null
  fecha_hora: string
  metodo_pago: string | null
  origen: OrigenGestion
  referencia_gestion_id: string | null
  observacion: string | null
  detalle?: Record<string, unknown>
}

/** Columnas que se piden al leer `gestiones` (una sola lista, un solo shape). */
export const COLUMNAS_GESTION =
  "id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion, monto, " +
  "cuota_objetivo, num_cuotas, fecha_hora, metodo_pago, origen, " +
  "referencia_gestion_id, observacion, detalle"

/** Genera la llave de idempotencia de una gestión (se crea AL CAPTURAR). */
export function nuevaGestionId(): string {
  return crypto.randomUUID()
}

/**
 * ¿Este evento movió plata hacia el préstamo?
 * LA definición de "pago" para contadores y totales. Una reversa resta.
 */
export function montoEfectivo(g: {
  tipo: TipoGestion
  // Suelto a propósito: PostgREST devuelve `numeric` como string y las filas
  // crudas llegan acá antes de normalizarse. `Number(...) || 0` ya lo resuelve
  // abajo; exigir `number` solo obligaba a convertir en cada sitio de llamada.
  monto: number | string | null
}): number {
  switch (g.tipo) {
    case "pago":
    case "cancelacion":
    case "abono_venta":
      return Number(g.monto) || 0
    case "reversa":
      return -(Number(g.monto) || 0)
    default:
      return 0
  }
}

/** Un evento que el cobrador reconocería como "le cobré". */
export function esPagoReal(g: Pick<Gestion, "tipo" | "monto" | "estado">): boolean {
  return (
    g.estado === "aplicada" &&
    (g.tipo === "pago" || g.tipo === "cancelacion" || g.tipo === "abono_venta") &&
    Number(g.monto) > 0
  )
}

/** Eventos que representan una VISITA al cliente (cuentan como gestión del día). */
export function esVisita(g: Pick<Gestion, "tipo">): boolean {
  return g.tipo === "pago" || g.tipo === "no_pago" || g.tipo === "cancelacion"
}

/** Lo mínimo que necesita un evento para poder colapsarse. */
export interface EventoColapsable {
  loan_id: string
  tipo: TipoGestion
  monto: number | string | null
  fecha_hora: string | null
}

/** Una fila: un cliente, un día, un resultado. */
export interface MovimientoColapsado<T> {
  loanId: string
  /** La plata que quedó puesta ese día, ya neteada. */
  neto: number
  estado: "pagado" | "no_pago"
  /** Todos los eventos del cliente ese día, en orden. El rastro completo. */
  eventos: T[]
  /**
   * El evento que representa la fila. De él salen la hora y el GPS: es el
   * último que decidió el resultado, prefiriendo uno con coordenadas.
   */
  representante: T
}

/**
 * UN CLIENTE, UN DÍA, UNA FILA.
 *
 * Es el espejo en TypeScript de lo que hace `resumen_diario_v2` en SQL
 * (script 070), y existe para que la LISTA y el CONTADOR no puedan
 * discrepar: si la vista dice 13 pagos, esto devuelve 13 filas.
 *
 * Sin esto, una tarde de correcciones se ve así en el detalle del día:
 *
 *   jenny condori carvajal   ajuste   $0        09:45
 *   jenny condori carvajal   ajuste   $0        09:45
 *   ... (seis más)
 *   jenny condori carvajal   pagado   $97.500   09:48
 *   jenny condori carvajal   pagado   $97.500   09:48
 *
 * Diez renglones del mismo cliente, ocho de ellos en cero. Es el libro
 * crudo, y el libro tiene razón en guardarlo todo — cada corrección lleva su
 * firma y su hora. Pero quien mira el día quiere saber qué pasó con jenny, y
 * con jenny pasó UNA cosa: quedó pagando $195.000.
 *
 * LA REGLA (la misma del 070):
 *   neto > 0                    -> una fila "pagado" por ese neto
 *   neto <= 0 y hubo un no_pago -> una fila "no_pago"
 *   neto = 0 sin no_pago        -> NO aparece
 *
 * El último caso es a propósito: un pago que se registró y se anuló no dejó
 * nada, y una edición de cronograma en $0 no es un movimiento de plata. Si
 * se listaran, la lista tendría más renglones que el contador y volveríamos
 * al mismo problema por otra puerta.
 */
export function colapsarPorCliente<T extends EventoColapsable>(
  eventos: T[],
  opts?: { tieneGps?: (e: T) => boolean },
): MovimientoColapsado<T>[] {
  const porLoan = new Map<string, T[]>()
  for (const e of eventos) {
    const lista = porLoan.get(e.loan_id)
    if (lista) lista.push(e)
    else porLoan.set(e.loan_id, [e])
  }

  const filas: MovimientoColapsado<T>[] = []
  for (const [loanId, lista] of porLoan) {
    const orden = [...lista].sort((a, b) => tiempo(a.fecha_hora) - tiempo(b.fecha_hora))
    const neto = orden.reduce((s, e) => s + montoEfectivo(e), 0)
    const huboNoPago = orden.some((e) => e.tipo === "no_pago")

    const estado: "pagado" | "no_pago" | null =
      neto > 0 ? "pagado" : huboNoPago ? "no_pago" : null
    if (estado === null) continue

    // Los eventos que DECIDIERON el resultado. La hora y el GPS de la fila
    // salen de ahí, no del último papel que se haya tocado: un ajuste de
    // cronograma posterior no puede robarle la hora a la visita real.
    const decisivos = orden.filter((e) =>
      estado === "pagado" ? montoEfectivo(e) > 0 : e.tipo === "no_pago",
    )
    const candidatos = decisivos.length > 0 ? decisivos : orden
    const conGps = opts?.tieneGps ? candidatos.filter(opts.tieneGps) : []
    const pool = conGps.length > 0 ? conGps : candidatos

    filas.push({
      loanId,
      neto,
      estado,
      eventos: orden,
      representante: pool[pool.length - 1],
    })
  }

  return filas.sort(
    (a, b) => tiempo(a.representante.fecha_hora) - tiempo(b.representante.fecha_hora),
  )
}

function tiempo(ts: string | null | undefined): number {
  if (!ts) return 0
  const t = new Date(ts).getTime()
  return Number.isNaN(t) ? 0 : t
}

/** Resumen de lo que se le hizo a un préstamo en un día. */
export interface ResumenDia {
  gestionado: boolean
  tipo: "pago" | "no_pago" | null
  monto: number
  cuotas: number
  hora: string
  /**
   * La marca de tiempo CRUDA de la última visita del día, tal como vino de la
   * base. `""` cuando no hubo ninguna.
   *
   * Existe aparte de `hora` porque `hora` es para leer —"01:05 p. m."— y con
   * eso no se puede ordenar: comparando texto, "12:58 p. m." va DESPUÉS de
   * "01:05 p. m." y la lista queda al revés justo en el cambio de mediodía.
   */
  instante: string
  /**
   * CÓMO pagó ese día: 'efectivo', 'transferencia' o 'mixto'.
   *
   * `null` cuando no entró plata (un no pago no tiene forma de pago).
   *
   * Sale del `metodo_pago` de los eventos que trajeron dinero, con la regla de
   * siempre: vacío cuenta como efectivo, porque así lo cuenta la vista del
   * resumen y la lista no puede decir otra cosa que la cifra.
   */
  metodo: "efectivo" | "transferencia" | "mixto" | null
}

/**
 * Qué pasó con este préstamo el día D. Sustituye el viejo triple predicado
 * sobre estados de cuota, horas y fecha_pago que hacía que una gestión
 * aplicada a ayer se "comiera" el día de hoy del cliente.
 */
export function resumenDelDia(gestiones: Gestion[], loanId: string, dia: string): ResumenDia {
  // Eventos ANULADOS: una reversa apunta al evento que compensa. Si el
  // cobrador anula el pago que acaba de registrar, esa visita deja de contar
  // y el cliente vuelve a la lista de pendientes — que es lo que uno espera
  // al deshacer algo. El historial conserva las dos cosas: el pago y su
  // anulación, con hora y usuario.
  const anulados = new Set(
    gestiones
      .filter((g) => g.tipo === "reversa" && g.estado === "aplicada" && g.referencia_gestion_id)
      .map((g) => g.referencia_gestion_id as string),
  )

  const delDia = gestiones.filter(
    (g) => g.loan_id === loanId && g.fecha_gestion === dia && g.estado === "aplicada",
  )
  const idsDelDia = new Set(delDia.map((g) => g.id))

  // El evento anulado y la reversa que lo anula se cancelan entre sí: para
  // el día es como si no hubiera pasado nada. Se descartan los dos, o el
  // monto quedaría restado dos veces.
  const vivos = delDia.filter((g) => {
    if (anulados.has(g.id)) return false
    if (g.tipo === "reversa" && g.referencia_gestion_id && idsDelDia.has(g.referencia_gestion_id)) {
      return false
    }
    return true
  })

  const visitas = vivos.filter(esVisita)
  if (visitas.length === 0) {
    return { gestionado: false, tipo: null, monto: 0, cuotas: 0, hora: "", instante: "", metodo: null }
  }
  const monto = vivos.reduce((s, g) => s + montoEfectivo(g), 0)
  const conPlata = visitas.filter((g) => Number(g.monto) > 0)
  const ultima = visitas.reduce((a, b) => (a.fecha_hora > b.fecha_hora ? a : b))
  // La forma de pago solo se mira en los eventos que trajeron plata: una
  // visita sin pago no tiene forma de pago que mostrar.
  const formas = new Set(
    conPlata.map((g) =>
      (g.metodo_pago ?? "").trim().toLowerCase() === "transferencia" ? "transferencia" : "efectivo",
    ),
  )

  return {
    gestionado: true,
    tipo: conPlata.length > 0 ? "pago" : "no_pago",
    monto,
    cuotas: conPlata.reduce((s, g) => s + (g.num_cuotas || 1), 0),
    hora: horaColombia(ultima.fecha_hora),
    instante: ultima.fecha_hora,
    metodo:
      formas.size === 0 ? null
      : formas.size > 1 ? "mixto"
      : (formas.has("transferencia") ? "transferencia" : "efectivo"),
  }
}

// ── Estados de cuota ───────────────────────────────────────────────────────

export type EstadoCuota = "pendiente" | "pagado" | "parcial" | "no_pago" | "cancelada"

export const ESTADOS_CUOTA: EstadoCuota[] = [
  "pendiente", "pagado", "parcial", "no_pago", "cancelada",
]

/** La cuota quedó saldada (con plata o por cancelación del crédito). */
export function cuotaCubierta(estado: string | null | undefined): boolean {
  return estado === "pagado" || estado === "cancelada"
}

/** La cuota ya se tocó: no está esperando gestión. */
export function cuotaGestionada(estado: string | null | undefined): boolean {
  return estado === "pagado" || estado === "cancelada" || estado === "parcial" || estado === "no_pago"
}

// ── Mora ───────────────────────────────────────────────────────────────────
//
// El número de mora es una CANTIDAD DE CUOTAS vencidas sin cubrir, no días.
// Se venía mostrando como "Nd mora", que confundía a todo el mundo.

/** Colores de la lista de cobro: al día, atrasado, crítico. */
export function colorMora(cuotasMora: number): "verde" | "amarillo" | "rojo" {
  if (cuotasMora <= 4) return "verde"
  if (cuotasMora <= 8) return "amarillo"
  return "rojo"
}

/**
 * Bandas de cartera de los informes (resumen del día y cierre de caja).
 *
 * SON LAS MISMAS QUE LOS COLORES DE LA LISTA DE COBRO, y se derivan de ellos
 * para que no puedan separarse. Antes tenían umbrales distintos: la lista
 * pintaba verde hasta 4, pero el informe solo contaba "al día" con CERO. El
 * mismo cliente salía verde en el teléfono del cobrador y "en mora" en el
 * informe de la oficina.
 *
 *   al día   hasta 4    (verde)
 *   mora     de 5 a 8   (amarillo)
 *   vencido  más de 8   (rojo)
 */
export function bandaCartera(cuotasMora: number): "al_dia" | "mora" | "vencido" {
  const color = colorMora(cuotasMora)
  return color === "verde" ? "al_dia" : color === "amarillo" ? "mora" : "vencido"
}

/** Etiqueta corta para la UI: "3 cuotas" / "1 cuota" / "al día". */
export function etiquetaMora(cuotasMora: number): string {
  if (cuotasMora <= 0) return "al día"
  return cuotasMora === 1 ? "1 cuota" : `${cuotasMora} cuotas`
}

// ── Frecuencias ────────────────────────────────────────────────────────────

export const FRECUENCIAS: Record<string, { etiqueta: string; dias: number }> = {
  daily:    { etiqueta: "Diario",     dias: 1 },
  weekly:   { etiqueta: "Semanal",    dias: 7 },
  biweekly: { etiqueta: "Quincenal",  dias: 15 },
  monthly:  { etiqueta: "Mensual",    dias: 30 },
}

export function etiquetaFrecuencia(frecuencia: string | null | undefined): string {
  return FRECUENCIAS[frecuencia ?? "daily"]?.etiqueta ?? "Diario"
}

export function esDiario(frecuencia: string | null | undefined): boolean {
  return (frecuencia ?? "daily") === "daily"
}

// ── Métodos de interés ─────────────────────────────────────────────────────
//
// Los nombres viejos ("Americano", "Alemán") no le decían nada a nadie: había
// que saberse la convención para entender qué cobraba cada uno. Los valores
// GUARDADOS no cambian — 'aleman' y 'americano' siguen en la base —, solo
// cambia cómo se muestran.

export type TipoAmortizacion = "aleman" | "americano" | "empleado"

export const AMORTIZACIONES: { valor: TipoAmortizacion; etiqueta: string; ayuda: string }[] = [
  {
    valor: "aleman",
    etiqueta: "Cuota fija",
    ayuda: "Todas las cuotas valen lo mismo: capital e interés repartidos parejo.",
  },
  {
    valor: "americano",
    etiqueta: "Cuota interés",
    ayuda: "Cada cuota paga solo el interés; el capital completo entra en la última.",
  },
]

export function etiquetaAmortizacion(tipo: string | null | undefined): string {
  switch (tipo) {
    case "aleman": return "Cuota fija"
    case "americano": return "Cuota interés"
    case "empleado": return "Empleado"
    default: return tipo ?? "—"
  }
}

// ── Cómo se llama el cliente ───────────────────────────────────────────────

/**
 * El apodo, SOLO cuando dice algo que el nombre no dice.
 *
 * Casi todos los clientes se conocen por el apodo —"kiosko", "la peluquería",
 * "verduras 2"— y por eso las listas de la calle lo muestran de primero. Pero
 * cuando hay que identificar a alguien sin lugar a dudas —corregir un pago,
 * anular una venta— hace falta el nombre de la cédula, con el apodo debajo.
 *
 * Devuelve `null` cuando repetirlo no agregaría nada: cuando está vacío o
 * cuando es el mismo nombre. Sin esta comprobación, media lista sale con la
 * misma línea escrita dos veces, y ocupa el doble para no decir nada.
 *
 * La comparación ignora mayúsculas y espacios de sobra porque los dos campos
 * se escriben a mano y en la base conviven "KIOSKO", "kiosko" y "kiosko ".
 */
export function apodoSiAporta(
  nombre: string | null | undefined,
  apodo: string | null | undefined,
): string | null {
  const a = (apodo ?? "").trim()
  if (!a) return null
  const n = (nombre ?? "").trim()
  return a.toLowerCase() === n.toLowerCase() ? null : a
}

// ── Dinero ─────────────────────────────────────────────────────────────────

export function fmtMoneda(valor: number | null | undefined): string {
  return `$${Math.round(Number(valor) || 0).toLocaleString("es-CO")}`
}

// ── Cuotas con decimal ─────────────────────────────────────────────────────

/**
 * CUÁNTAS CUOTAS LLEVA PAGADAS, CON UN DECIMAL.
 *
 * `v_loan_financiero.cuotas_cubiertas` es un ENTERO por construcción — la
 * vista hace `FLOOR(pagado_neto / valor_cuota)` desde el script 084 —, así que
 * un cliente que lleva cinco cuotas y media aparecía como 5, igual que uno que
 * acababa de pagar la quinta. Media cuota de diferencia, invisible.
 *
 * Acá se hace la misma división SIN el piso: 5,5 se muestra como "5.5". Se
 * calcula sobre la misma plata (`total_pagado`) y la misma cuota de referencia
 * que usa la vista, así que la parte entera coincide siempre con el
 * `cuotas_cubiertas` de la base — nunca puede decir 6 donde la vista dice 5.
 *
 * SE TOPA EN EL TOTAL, igual que la vista (`LEAST(cob.totales, ...)`), para
 * que un crédito con extras no diga 27.3/25.
 *
 * EL SEPARADOR ES UN PUNTO, no la coma de es-CO: es el formato que se pidió
 * ("5.5", "1.80"). Las cifras de plata siguen con punto de miles —$19.500— y
 * son de otro orden de magnitud, así que no se confunden.
 */
export function cuotasConDecimal(
  pagado: number | null | undefined,
  valorCuota: number | null | undefined,
  totales?: number | null,
): string {
  const cuota = Number(valorCuota) || 0
  if (cuota <= 0) return "0.0"
  const crudo = (Number(pagado) || 0) / cuota
  const tope = Number(totales)
  const n = Number.isFinite(tope) && tope > 0 ? Math.min(crudo, tope) : crudo
  return (Math.max(0, n)).toFixed(1)
}

/**
 * EL MONTO, ESCRITO COMO PLATA: "$ 19.500".
 *
 * Vivía dentro del módulo de pagos, que fue donde se necesitó primero. Se
 * mudó acá porque el dueño lo pidió para toda la app: gastos, ingresos,
 * retiros y ventas también se teclean a contraluz, y un `302500` sin puntos
 * hay que leerlo cifra por cifra para saber si son trescientos mil o tres
 * millones.
 *
 * El estado sigue guardando el número CRUDO —"19500" o "19500.75"— porque es
 * lo que leen los `Number.parseFloat` de media app. Lo único que cambia es lo
 * que se ve y lo que se acepta al teclear.
 *
 * SE ACEPTA LA COMA COMO DECIMAL, y no es un detalle de estilo: en Ecuador las
 * cuotas llevan centavos (el script 087 no redondea nada por debajo de $1.000),
 * así que un campo que solo tragara dígitos dejaría a esa ruta sin poder cobrar
 * $19,50. El punto es SIEMPRE separador de miles, como en el resto de la app.
 */
export function mostrarMonto(crudo: string): string {
  if (!crudo) return ""
  const [ent, dec] = crudo.split(".")
  const n = Number(ent || "0")
  const miles = Number.isFinite(n) ? n.toLocaleString("es-CO") : ent
  // El ",00" de un `toFixed(2)` no se muestra: varios campos derivados llegan
  // así —"650000.00"— y en pesos colombianos esos dos ceros son ruido en la
  // cifra que hay que leer de un vistazo.
  //
  // SOLO se descarta "00", los DOS dígitos completos. Descartar cualquier cero
  // rompía el tecleo: escribiendo "19,05" se pasa por "19,0", y ahí un
  // `Number(dec) === 0` se comía la coma y dejaba "$ 19" — no se podían
  // escribir centavos que empiecen en cero. Con "19,0" a medias `dec` es "0",
  // no "00", así que la coma sobrevive hasta que el número esté completo.
  if (dec === "00") return `$ ${miles}`
  return dec !== undefined ? `$ ${miles},${dec}` : `$ ${miles}`
}

/** El camino de vuelta: de "$ 19.500,75" al crudo "19500.75" que se guarda. */
export function leerMonto(texto: string): string {
  const soloValidos = texto.replace(/[^0-9,]/g, "")
  if (!soloValidos) return ""
  const partes = soloValidos.split(",")
  // Se quitan los ceros de adelante para que no quede "0019500", pero un "0"
  // solo tiene que sobrevivir: es lo que se ve mientras se borra el campo.
  const enteros = partes[0].replace(/^0+(?=[0-9])/, "")
  if (partes.length === 1) return enteros
  return `${enteros || "0"}.${partes.slice(1).join("").slice(0, 2)}`
}
