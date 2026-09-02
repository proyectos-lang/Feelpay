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
 * - Strings DATE ("YYYY-MM-DD"): se reordenan tal cual, sin zona horaria.
 * - Strings TIMESTAMPTZ ("...Z" o "...+00:00"): se convierten a hora Colombia.
 */
export function fmtFecha(value: string | null | undefined): string {
  if (!value) return "—"
  // Una fecha DATE no tiene zona horaria: es el día, y ya. Se reordena sin
  // pasar por `Date`.
  //
  // ANTES se parseaba como medianoche LOCAL y se formateaba en Bogotá, y eso
  // corría el día un puesto para atrás en cualquier teléfono al este de Colombia:
  // en Argentina (UTC-3), "2026-08-31" se leía 30/08/2026. Colombia y Ecuador
  // no lo notaban por estar los dos en UTC-5.
  if (!value.includes("T")) {
    const [a, m, d] = value.slice(0, 10).split("-")
    return a && m && d ? `${d}/${m}/${a}` : "—"
  }
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value))
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
