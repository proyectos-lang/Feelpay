"use client"

/**
 * El candado de la app.
 *
 * QUÉ CUENTA COMO "SALIR"
 * `visibilitychange` y nada más. Es el evento que dispara el navegador cuando
 * la página deja de estar a la vista: minimizar, cambiar de app, apagar la
 * pantalla, cerrar la pestaña.
 *
 * NO se usa `blur`/`focus` a propósito, aunque parezcan lo mismo. Un
 * `<input type="file">` abriendo la galería, un permiso de ubicación, un
 * diálogo del navegador — todos roban el foco sin que la página deje de estar
 * visible. Con `blur` el cobrador quedaría pidiendo el PIN cada vez que la
 * app le pide la cámara, que es varias veces por cliente.
 *
 * QUEDARSE QUIETO TAMBIÉN CUENTA
 * A los 45 segundos sin tocar nada, con la app en primer plano, el candado se
 * arma solo. Es el caso del teléfono que se queda encima de un mostrador o en
 * la mano de otro: no hubo `visibilitychange` porque nadie minimizó nada.
 *
 * El reloj se PARA mientras la app está oculta. Si corriera en segundo plano,
 * volver de tomar una foto de cédula —la salida exenta— encontraría el candado
 * armado igual, y la exención no serviría de nada.
 *
 * ABRIR LA APP TAMBIÉN CUENTA
 * "Cerrar el sistema y volverlo a abrir" es una recarga de la página. Al
 * montar, si hay sesión guardada, se arranca BLOQUEADO. La única forma de
 * arrancar abierto es que el login haya ocurrido en esta misma vida de la
 * página, y eso vive en memoria (`recienAutenticado`), no en `localStorage`:
 * si viviera en disco, sobreviviría al cierre y el candado no serviría.
 *
 * ...SALVO CUANDO LA RECARGA LA HIZO LA APP
 * Actualizar a la versión nueva es una recarga, y para el candado se veía
 * idéntica a cerrar y volver a abrir: el cobrador tecleaba el PIN cada vez que
 * apretaba "Actualizar". La app avisa antes de recargarse (`marcarRecargaPropia`)
 * y esa vuelta entra sin candado.
 *
 * La marca vive en `sessionStorage` y NO en `localStorage`, que es lo que hace
 * que esto no abra un hueco: `sessionStorage` muere con la pestaña. Sobrevive
 * a la recarga que la app acaba de provocar y a nada más — cerrar la app y
 * volverla a abrir sigue pidiendo el PIN.
 *
 * A QUIEN SE LE PIDE
 * Solo a la gente de calle (`ROLES_CON_PIN`). Secretaría, admin, gerencia,
 * liquidador y socioadmin entran sin PIN: trabajan sentados frente a un
 * computador que no se levanta de una mesa, y el candado les cobraba el mismo
 * peaje sin resolverles el riesgo que lo motivó — un celular desbloqueado en
 * la calle.
 *
 * LO QUE EL CANDADO NO ES
 * No protege los datos: quien tenga el teléfono puede abrir el navegador y
 * leer `localStorage`, y la llave pública de la app deja consultar Supabase
 * igual. Esto detiene a quien levanta un celular desbloqueado y toca el
 * ícono — que es lo que se pidió — no a quien sabe lo que hace.
 */

import { createClient } from "@/lib/supabase/client"

/**
 * Los roles a los que se les pide el PIN.
 *
 * Va por lista de quién SÍ, no de quién no. Con la lista invertida, un rol
 * nuevo quedaría con candado sin que nadie lo hubiera decidido, y el dueño se
 * enteraría por una queja. Así, un rol nuevo entra sin PIN hasta que alguien
 * lo agregue a mano, que es una decisión visible.
 *
 * `asesor` va junto a `vendedor` porque el catálogo de módulos los trata como
 * el mismo trabajo (`defaultRoles: ["vendedor", "asesor"]`): los dos salen a
 * la calle con el teléfono.
 */
export const ROLES_CON_PIN = ["vendedor", "asesor"] as const

/** ¿A este rol se le pide el PIN al volver a la app? */
export function requierePin(rol: string | null | undefined): boolean {
  const r = (rol ?? "").toLowerCase().trim()
  return (ROLES_CON_PIN as readonly string[]).includes(r)
}

/** Cuántos intentos seguidos antes de mandar a la persona al login completo. */
export const INTENTOS_MAX = 10

/**
 * Cuánto puede estar la app quieta, en primer plano, antes de armar el candado.
 *
 * 45 segundos. Es corto a propósito: el riesgo que esto ataja es un teléfono
 * desbloqueado que cambia de manos, y eso pasa en segundos. Cualquier toque
 * —un scroll, una tecla— reinicia la cuenta, así que a quien está trabajando
 * no lo interrumpe nunca.
 */
export const INACTIVIDAD_PIN_MS = 45 * 1000

// ── La recarga que hace la app misma ────────────────────────────────────────
//
// `sessionStorage` y no `localStorage`: muere con la pestaña. Sobrevive a la
// recarga que la app provoca y a nada más.
const CLAVE_RECARGA = "pinRecargaPropia"

/** La app está por recargarse (actualizar versión). Esa vuelta no pide PIN. */
export function marcarRecargaPropia(): void {
  try { sessionStorage.setItem(CLAVE_RECARGA, "1") } catch { /* modo privado */ }
}

/** ¿Esta carga viene de una recarga que hizo la app? La consume: vale una vez. */
export function fueRecargaPropia(): boolean {
  try {
    if (sessionStorage.getItem(CLAVE_RECARGA) !== "1") return false
    sessionStorage.removeItem(CLAVE_RECARGA)
    return true
  } catch {
    return false
  }
}

// ── Cuando la app misma abre algo del sistema ───────────────────────────────
//
// Tomar la foto de una cédula manda la app a segundo plano: se abre la cámara
// del teléfono. Pero la persona NO se fue — está en mitad de una venta, con el
// formulario abierto, haciendo lo que la app le pidió. Pedirle el PIN ahí es
// como pedírselo por pasar de una pantalla a otra.
//
// Así que la app avisa antes de abrir la cámara y esa salida queda exenta.
// No es un margen de tiempo general: es UNA salida, la que la app provocó, y
// se consume al usarla. Cualquier otra sigue pidiendo el PIN.
//
// El tope de dos minutos es la red de seguridad: si alguien abre la cámara y
// se va a hacer otra cosa con el teléfono, al volver el PIN aparece igual.
// Tomar una foto no toma dos minutos; irse sí.
const MAX_FUERA_MS = 2 * 60 * 1000

let exencionPendiente = false
let salioEn = 0

/** La app está por abrir la cámara. La próxima salida no cuenta como irse. */
export function abriendoAlgoDelSistema(): void {
  exencionPendiente = true
}

/** ¿Esta salida está exenta? La consume: solo vale una vez. */
export function salidaExenta(): boolean {
  if (!exencionPendiente) return false
  exencionPendiente = false
  salioEn = Date.now()
  return true
}

/** Volviendo de una salida exenta: ¿se tardó más de lo que toma una foto? */
export function volvioTarde(): boolean {
  if (!salioEn) return false
  const tarde = Date.now() - salioEn > MAX_FUERA_MS
  salioEn = 0
  return tarde
}

export interface ResultadoPin {
  ok: boolean
  /** Se pasó de intentos: solo sale entrando con usuario y contraseña. */
  bloqueado: boolean
  restantes: number
}

/**
 * Le pregunta al servidor si el PIN es el correcto.
 *
 * El PIN nunca se compara en el teléfono: acá solo se manda y se recibe un
 * sí o un no. El hash no sale de la base — la llave pública ni siquiera
 * tiene permiso de leer esa columna (script 073, paso 5).
 */
export async function verificarPin(userId: number | string, pin: string): Promise<ResultadoPin> {
  const { data, error } = await createClient().rpc("verificar_pin", {
    p_user_id: Number(userId),
    p_pin: pin,
  })

  if (error) {
    console.error("[v0] verificar_pin error:", error.message)
    // Ante un error de red NO se abre el candado. Se avisa y se deja
    // reintentar: abrirlo "por las dudas" seria justo lo contrario de lo que
    // este archivo existe para hacer.
    throw new Error("No se pudo verificar el PIN. Revisa la conexión.")
  }

  const r = (data ?? {}) as { ok?: boolean; bloqueado?: boolean; restantes?: number }
  return {
    ok: !!r.ok,
    bloqueado: !!r.bloqueado,
    restantes: typeof r.restantes === "number" ? r.restantes : INTENTOS_MAX,
  }
}

export async function cambiarPin(
  userId: number | string,
  pinActual: string,
  pinNuevo: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await createClient().rpc("cambiar_pin", {
    p_user_id: Number(userId),
    p_pin_actual: pinActual,
    p_pin_nuevo: pinNuevo,
  })

  if (error) {
    console.error("[v0] cambiar_pin error:", error.message)
    return { ok: false, error: "No se pudo cambiar el PIN. Revisa la conexión." }
  }

  const r = (data ?? {}) as { ok?: boolean; error?: string }
  return { ok: !!r.ok, error: r.error }
}

/**
 * Los PIN de todos, para Usuarios y Rutas.
 *
 * Pide usuario y contraseña de quien consulta y los comprueba EN EL SERVIDOR
 * contra la tabla. No alcanza con decir "soy secretaria": el rol viaja en el
 * teléfono y ahí se puede escribir a mano; una contraseña no.
 *
 * Devuelve un mapa `{ "3": "0000", "7": "4821" }` — id de usuario a PIN.
 */
export async function verPines(
  usuario: string,
  password: string,
): Promise<{ ok: boolean; error?: string; pines: Record<string, string> }> {
  const { data, error } = await createClient().rpc("ver_pines", {
    p_usuario: usuario,
    p_password: password,
  })

  if (error) {
    console.error("[v0] ver_pines error:", error.message)
    return { ok: false, error: "No se pudieron leer los PIN. Revisa la conexión.", pines: {} }
  }

  const r = (data ?? {}) as { ok?: boolean; error?: string; pines?: Record<string, string> }
  return { ok: !!r.ok, error: r.error, pines: r.pines ?? {} }
}

/** ¿Esta persona sigue con el 0000? Para avisárselo, no para bloquearla. */
export async function pinSigueEnDefault(userId: number | string): Promise<boolean> {
  try {
    const { data, error } = await createClient()
      .from("usuarios")
      .select("pin_cambiado")
      .eq("id", Number(userId))
      .maybeSingle()
    if (error) return false
    return (data as { pin_cambiado?: boolean } | null)?.pin_cambiado === false
  } catch {
    return false
  }
}
