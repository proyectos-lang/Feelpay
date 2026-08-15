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
export function montoEfectivo(g: Pick<Gestion, "tipo" | "monto">): number {
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

/** Resumen de lo que se le hizo a un préstamo en un día. */
export interface ResumenDia {
  gestionado: boolean
  tipo: "pago" | "no_pago" | null
  monto: number
  cuotas: number
  hora: string
}

/**
 * Qué pasó con este préstamo el día D. Sustituye el viejo triple predicado
 * sobre estados de cuota, horas y fecha_pago que hacía que una gestión
 * aplicada a ayer se "comiera" el día de hoy del cliente.
 */
export function resumenDelDia(gestiones: Gestion[], loanId: string, dia: string): ResumenDia {
  const delDia = gestiones.filter(
    (g) => g.loan_id === loanId && g.fecha_gestion === dia && g.estado === "aplicada",
  )
  const visitas = delDia.filter(esVisita)
  if (visitas.length === 0) {
    return { gestionado: false, tipo: null, monto: 0, cuotas: 0, hora: "" }
  }
  const monto = delDia.reduce((s, g) => s + montoEfectivo(g), 0)
  const conPlata = visitas.filter((g) => Number(g.monto) > 0)
  const ultima = visitas.reduce((a, b) => (a.fecha_hora > b.fecha_hora ? a : b))
  return {
    gestionado: true,
    tipo: conPlata.length > 0 ? "pago" : "no_pago",
    monto,
    cuotas: conPlata.reduce((s, g) => s + (g.num_cuotas || 1), 0),
    hora: horaColombia(ultima.fecha_hora),
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

/** Bandas de cartera de los informes (resumen del día y cierre de caja). */
export function bandaCartera(cuotasMora: number): "al_dia" | "mora" | "vencido" {
  if (cuotasMora <= 0) return "al_dia"
  if (cuotasMora <= 8) return "mora"
  return "vencido"
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

// ── Dinero ─────────────────────────────────────────────────────────────────

export function fmtMoneda(valor: number | null | undefined): string {
  return `$${Math.round(Number(valor) || 0).toLocaleString("es-CO")}`
}
