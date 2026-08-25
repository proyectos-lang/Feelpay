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
 * ABRIR LA APP TAMBIÉN CUENTA
 * "Cerrar el sistema y volverlo a abrir" es una recarga de la página. Al
 * montar, si hay sesión guardada, se arranca BLOQUEADO. La única forma de
 * arrancar abierto es que el login haya ocurrido en esta misma vida de la
 * página, y eso vive en memoria (`recienAutenticado`), no en `localStorage`:
 * si viviera en disco, sobreviviría al cierre y el candado no serviría.
 *
 * LO QUE EL CANDADO NO ES
 * No protege los datos: quien tenga el teléfono puede abrir el navegador y
 * leer `localStorage`, y la llave pública de la app deja consultar Supabase
 * igual. Esto detiene a quien levanta un celular desbloqueado y toca el
 * ícono — que es lo que se pidió — no a quien sabe lo que hace.
 */

import { createClient } from "@/lib/supabase/client"

/** Cuántos intentos seguidos antes de mandar a la persona al login completo. */
export const INTENTOS_MAX = 10

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
