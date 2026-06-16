// Zona horaria oficial de Colombia (UTC-5, sin horario de verano)
const TZ = "America/Bogota"

/**
 * Retorna la fecha actual en Colombia como "YYYY-MM-DD".
 * Usar para todos los campos DATE que se insertan en la BD.
 */
export function todayColombia(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

/**
 * Convierte un timestamp UTC (o ISO) de la BD a su fecha Colombia "YYYY-MM-DD".
 * Útil para filtros por fecha cuando el campo almacenado es un TIMESTAMPTZ.
 */
export function tsToColombiaDate(ts: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts))
}

/**
 * Formatea una fecha o timestamp de la BD para mostrar como "DD/MM/AAAA".
 * - Strings DATE ("YYYY-MM-DD"): se parsean como hora local para evitar el
 *   desplazamiento UTC medianoche.
 * - Strings TIMESTAMPTZ ("...Z" o "...+00:00"): se convierten a hora Colombia.
 */
export function fmtFecha(value: string | null | undefined): string {
  if (!value) return "—"
  const d = value.includes("T") ? new Date(value) : new Date(value + "T00:00:00")
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d)
}

/**
 * Formatea un timestamp UTC de la BD para mostrar fecha + hora en Colombia.
 * Ejemplo: "15/06/2026 08:30 p. m."
 */
export function fmtFechaHora(value: string | null | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value))
}
